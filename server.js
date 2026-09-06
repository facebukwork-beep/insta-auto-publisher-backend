import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createPersistence } from "./persistence.js";
import { createMediaStore } from "./media-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const GRAPH = process.env.GRAPH_API_VERSION || "v23.0";
const SECRET = process.env.APP_SECRET_KEY || "";
const PREPARE_AHEAD_MS = Number(process.env.PREPARE_AHEAD_MINUTES || 10) * 60_000;
const META_MIN_REQUEST_INTERVAL_MS = Math.max(5, Number(process.env.META_MIN_REQUEST_INTERVAL_SECONDS || 10)) * 1000;
const RATE_LIMIT_BACKOFF_MS = Math.max(5, Number(process.env.META_RATE_LIMIT_BACKOFF_MINUTES || 30)) * 60_000;
const MAX_AUTO_RETRIES = Math.max(1, Number(process.env.MAX_AUTO_RETRIES || 8));
const REQUIRE_RESTART_SAFE_STORAGE = String(process.env.REQUIRE_RESTART_SAFE_STORAGE || "true").toLowerCase() !== "false";
const KEEP_MEDIA_AFTER_PUBLISH_HOURS = Math.max(0, Number(process.env.KEEP_MEDIA_AFTER_PUBLISH_HOURS || 24));
const GDRIVE_CLIENT_ID = String(process.env.GDRIVE_CLIENT_ID || "").trim();
const GDRIVE_CLIENT_SECRET = String(process.env.GDRIVE_CLIENT_SECRET || "").trim();
const LATE_JOB_GRACE_MS = Math.max(30, Number(process.env.LATE_JOB_GRACE_SECONDS || 120)) * 1000;
const CATCHUP_START_DELAY_MS = Math.max(15, Number(process.env.CATCHUP_START_DELAY_SECONDS || 60)) * 1000;
const BURST_SIZE = Math.max(1, Number(process.env.SCHEDULER_BURST_SIZE || 5));
const BURST_GAP_MINUTES = Math.max(1, Number(process.env.SCHEDULER_BURST_GAP_MINUTES || 10));
const BURST_BREAK_MINUTES = Math.max(BURST_GAP_MINUTES, Number(process.env.SCHEDULER_BURST_BREAK_MINUTES || 60));

if (!SECRET) {
  console.error("APP_SECRET_KEY is required.");
  process.exit(1);
}

const KEY = crypto.createHash("sha256").update(SECRET, "utf8").digest();
const persistentRoot = String(process.env.PERSISTENT_ROOT || "").trim();
const dataDir = persistentRoot ? path.join(persistentRoot, "data") : path.join(__dirname, "data");
const mediaDir = persistentRoot ? path.join(persistentRoot, "media") : path.join(__dirname, "media");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

const accountsFile = path.join(dataDir, "accounts.json");
const jobsFile = path.join(dataDir, "jobs.json");
if (!fs.existsSync(accountsFile)) fs.writeFileSync(accountsFile, "[]");
if (!fs.existsSync(jobsFile)) fs.writeFileSync(jobsFile, "[]");

const stateCache = new Map();
const read = (f) => {
  if (stateCache.has(f)) return stateCache.get(f);
  const value = JSON.parse(fs.readFileSync(f, "utf8"));
  stateCache.set(f, value);
  return value;
};
let persistence = null;
const write = (f, x) => {
  stateCache.set(f, x);
  // When Postgres is durable, the local JSON file is only a startup mirror and
  // does not need to be rewritten on every scheduler action. This keeps very
  // large monthly queues from causing huge ephemeral-disk writes.
  if (!persistence?.durable) fs.writeFileSync(f, JSON.stringify(x, null, 2));
  if (persistence) {
    const key = f === accountsFile ? "accounts" : f === jobsFile ? "jobs" : null;
    if (key) return persistence.persist(key, x);
  }
  return Promise.resolve();
};
const newId = () => crypto.randomUUID();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), ciphertext.toString("hex")].join(".");
}

function decrypt(payload) {
  const [ivHex, tagHex, dataHex] = payload.split(".");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

function generateTimes(count, start, end, gapMinutes) {
  const gap = Math.max(0, Number(gapMinutes || 0)) * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("Invalid random time window.");
  if (count > 1 && end - start < (count - 1) * gap) throw new Error("Time window is too short for the requested minimum gap.");
  const spare = (end - start) - (count - 1) * gap;
  const randoms = Array.from({ length: count }, () => Math.random()).sort((a, b) => a - b);
  return randoms.map((r, i) => Math.floor(start + r * spare + i * gap)).sort((a, b) => a - b);
}

function publicBaseUrl(req) {
  const explicit = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (explicit) return explicit;
  const renderUrl = (process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (renderUrl) return renderUrl;
  return `${req.protocol}://${req.get("host")}`;
}

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/media", express.static(mediaDir));

const upload = multer({
  dest: mediaDir,
  limits: { fileSize: 1024 * 1024 * 1024, files: 10 }
});

persistence = await createPersistence({ dataDir, accountsFile, jobsFile });

let schedulerControl = { paused: false, pausedAt: null, resumedAt: null, updatedAt: new Date().toISOString() };
try {
  const savedControl = await persistence?.get?.("scheduler_control");
  if (savedControl && typeof savedControl === "object") schedulerControl = { ...schedulerControl, ...savedControl };
} catch (e) {
  console.warn("Could not restore scheduler control state:", e.message);
}
async function saveSchedulerControl() {
  schedulerControl.updatedAt = new Date().toISOString();
  if (persistence?.set) await persistence.set("scheduler_control", schedulerControl);
}

const ACTIVE_QUEUE_STATUSES = new Set(["scheduled", "processing", "ready", "retry_wait"]);
function burstOffsetMs(index) {
  const group = Math.floor(index / BURST_SIZE);
  const within = index % BURST_SIZE;
  const groupSpan = ((BURST_SIZE - 1) * BURST_GAP_MINUTES + BURST_BREAK_MINUTES) * 60_000;
  return group * groupSpan + within * BURST_GAP_MINUTES * 60_000;
}
function resetPreparedContainerIfTooEarly(job, now) {
  const dueAt = new Date(job.scheduledAt).getTime();
  if (!job.containerId || dueAt - now <= PREPARE_AHEAD_MS) return;
  job.containerId = null;
  job.preparedAt = null;
  job.readyAt = null;
  job.status = "scheduled";
  job.nextAttemptAt = null;
}
function rebaseAccountQueue(jobs, accountId, startAt, reason) {
  const queue = jobs
    .filter(j => j.accountId === accountId && ACTIVE_QUEUE_STATUSES.has(j.status))
    .sort((a,b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
  if (!queue.length) return 0;
  const now = Date.now();
  queue.forEach((job, index) => {
    job.scheduledAt = new Date(startAt + burstOffsetMs(index)).toISOString();
    job.catchupReason = reason;
    job.catchupRebasedAt = new Date().toISOString();
    resetPreparedContainerIfTooEarly(job, now);
  });
  return queue.length;
}
function rebaseLateBacklog(jobs, now, reason = "late_wake_catchup") {
  const lateAccounts = [...new Set(jobs
    .filter(j => ACTIVE_QUEUE_STATUSES.has(j.status) && new Date(j.scheduledAt).getTime() < now - LATE_JOB_GRACE_MS)
    .map(j => j.accountId))];
  if (!lateAccounts.length) return 0;
  let changed = 0;
  const firstAt = now + CATCHUP_START_DELAY_MS;
  for (const accountId of lateAccounts) changed += rebaseAccountQueue(jobs, accountId, firstAt, reason);
  return changed;
}

let driveRefreshToken = String(process.env.GDRIVE_REFRESH_TOKEN || "").trim();
try {
  const saved = await persistence?.get?.("gdrive_oauth");
  if (saved?.tokenEnc) driveRefreshToken = decrypt(saved.tokenEnc);
} catch (e) {
  console.warn("Could not restore Google Drive OAuth token from durable state:", e.message);
}

async function saveDriveRefreshToken(token) {
  driveRefreshToken = String(token || "").trim();
  if (!driveRefreshToken) throw new Error("Google did not return a refresh token.");
  if (persistence?.durable && persistence?.set) {
    await persistence.set("gdrive_oauth", { tokenEnc: encrypt(driveRefreshToken), updatedAt: new Date().toISOString() });
  }
}

const mediaStore = createMediaStore({ mediaDir, persistentRoot, getDriveRefreshToken: () => driveRefreshToken });

function driveOAuthRedirectUri(req) {
  return String(process.env.GDRIVE_OAUTH_REDIRECT_URI || `${publicBaseUrl(req)}/api/google-drive/oauth/callback`).trim();
}

function makeDriveOAuthState() {
  const ts = Date.now().toString(36);
  const nonce = crypto.randomBytes(16).toString("hex");
  const payload = `${ts}.${nonce}`;
  const sig = crypto.createHmac("sha256", KEY).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyDriveOAuthState(state) {
  const parts = String(state || "").split(".");
  if (parts.length !== 3) return false;
  const [ts, nonce, sig] = parts;
  const payload = `${ts}.${nonce}`;
  const expected = crypto.createHmac("sha256", KEY).update(payload).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return false;
  } catch { return false; }
  const created = parseInt(ts, 36);
  return Number.isFinite(created) && Math.abs(Date.now() - created) < 15 * 60_000;
}

app.get("/api/google-drive/connect-info", (req, res) => {
  res.json({
    ok: true,
    configured: Boolean(GDRIVE_CLIENT_ID && GDRIVE_CLIENT_SECRET),
    connected: Boolean(driveRefreshToken),
    redirectUri: driveOAuthRedirectUri(req),
    clientIdHint: GDRIVE_CLIENT_ID ? `${GDRIVE_CLIENT_ID.slice(0, 8)}…${GDRIVE_CLIENT_ID.slice(-12)}` : null,
    connectUrl: `${publicBaseUrl(req)}/api/google-drive/connect`
  });
});

app.get("/api/google-drive/connect", (req, res) => {
  if (!GDRIVE_CLIENT_ID || !GDRIVE_CLIENT_SECRET) {
    return res.status(409).send("GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET must be configured first.");
  }
  const redirectUri = driveOAuthRedirectUri(req);
  const params = new URLSearchParams({
    client_id: GDRIVE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: makeDriveOAuthState()
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get("/api/google-drive/oauth/callback", async (req, res) => {
  const { code, state, error } = req.query || {};
  if (error) return res.status(400).send(`Google authorization failed: ${String(error)}`);
  if (!code || !verifyDriveOAuthState(state)) return res.status(400).send("Invalid or expired Google OAuth callback state.");
  try {
    const redirectUri = driveOAuthRedirectUri(req);
    const body = new URLSearchParams({
      code: String(code),
      client_id: GDRIVE_CLIENT_ID,
      client_secret: GDRIVE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code"
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok || !payload.refresh_token) {
      const detail = payload?.error_description || payload?.error || `HTTP ${r.status}`;
      throw new Error(`Google token exchange failed: ${detail}`);
    }
    await saveDriveRefreshToken(payload.refresh_token);
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:Arial;background:#08101d;color:#fff;padding:32px"><h1>✅ Google Drive connected</h1><p>The refresh token is now encrypted and saved in your durable Postgres state. You no longer need OAuth Playground or GDRIVE_REFRESH_TOKEN for this connection.</p><p><a style="color:#8ab4ff" href="/api/drive-test">Run Drive test</a></p></body>`);
  } catch (e) {
    res.status(502).type("text").send(String(e?.message || e));
  }
});

app.get("/drive-media/:fileId", async (req, res) => {
  if (!mediaStore?.stream) return res.status(404).send("Google Drive media storage is not configured.");
  try { await mediaStore.stream(req.params.fileId, req, res); }
  catch (e) { if (!res.headersSent) res.status(502).send(`Drive media proxy error: ${e.message}`); else res.end(); }
});

function storageStatus() {
  const statePersistent = Boolean(persistentRoot) || Boolean(persistence?.durable);
  const mediaPersistent = Boolean(mediaStore?.durable);
  const restartSafe = statePersistent && mediaPersistent;
  const reasons = [];
  if (!statePersistent) reasons.push("State is local/ephemeral. Configure DATABASE_URL or PERSISTENT_ROOT.");
  if (!mediaPersistent) reasons.push("Media is local/ephemeral. Configure Google Drive, S3/R2 storage, or PERSISTENT_ROOT.");
  return { statePersistent, mediaPersistent, restartSafe, reasons };
}

function requireSafeStorage(req, res, next) {
  const status = storageStatus();
  if (REQUIRE_RESTART_SAFE_STORAGE && !status.restartSafe) {
    return res.status(503).json({
      error: "Restart-safe storage is not configured. Bulk scheduling is blocked to prevent queued videos from disappearing after a restart/redeploy.",
      storage: status
    });
  }
  next();
}

app.get("/", (req, res) => {
  res.type("html").send(`<html><head><title>Insta Auto Publisher v14.6</title></head><body style="font-family:Arial;background:#0b1018;color:white;padding:40px"><h1>✅ Insta Auto Publisher v14.6 Monthly Smart + Pause/Resume Backend is Live</h1><p>Durable accounts/jobs + Google Drive media + restart-safe scheduler. Includes Monthly Smart 24H, global Pause/Resume, wake catch-up protection, and additive published/follower analytics.</p><p>Health: <code>/api/health</code></p><p>Graph API: <b>${GRAPH}</b></p></body></html>`);
});

app.get("/api/health", (req, res) => {
  const status = storageStatus();
  res.json({ ok: true, version: "14.6.0", graphApiVersion: GRAPH, publicBaseUrl: publicBaseUrl(req), persistence: persistence?.mode || "local", mediaStorage: mediaStore?.mode || "local", persistentRoot: persistentRoot || null, ...status, requireRestartSafeStorage: REQUIRE_RESTART_SAFE_STORAGE, prepareAheadMinutes: PREPARE_AHEAD_MS / 60_000, metaMinRequestIntervalSeconds: META_MIN_REQUEST_INTERVAL_MS / 1000, rateLimitBackoffMinutes: RATE_LIMIT_BACKOFF_MS / 60_000 });
});

app.get("/api/drive-test", async (req, res) => {
  if (mediaStore?.mode !== "gdrive" || typeof mediaStore.selfTest !== "function") return res.status(409).json({ ok:false, error:"Google Drive media storage is not configured." });
  try {
    const result = await mediaStore.selfTest();
    const folder = typeof mediaStore.folderInfo === "function" ? await mediaStore.folderInfo() : {};
    res.json({ ok:true, ...result, ...folder });
  } catch (e) {
    res.status(502).json({ ok:false, error:String(e?.message || e) });
  }
});

app.get("/api/storage-status", (req, res) => {
  const status = storageStatus();
  res.json({
    ok: true,
    state: persistence?.mode || "local",
    media: mediaStore?.mode || "local",
    persistentRoot: persistentRoot || null,
    ...status,
    safeToSchedule: !REQUIRE_RESTART_SAFE_STORAGE || status.restartSafe,
    requireRestartSafeStorage: REQUIRE_RESTART_SAFE_STORAGE,
    exactTimingWarning: !process.env.RENDER_INSTANCE_ID ? null : "A sleeping web service can still delay exact-time publishing. Durable storage prevents data loss, not service sleep."
  });
});

app.get("/api/accounts", (req, res) => res.json(read(accountsFile).map(({ tokenEnc, ...account }) => account)));

function makeBackupBlob(item) {
  return encrypt(JSON.stringify({ v: 2, label: item.label, igUserId: item.igUserId, tokenEnc: item.tokenEnc }));
}

// v11.2 recovery pack: lets the extension continuously mirror encrypted
// account recovery blobs into chrome.storage.sync. No plaintext access token is
// returned. This endpoint is especially useful before a Render redeploy/reset.
app.get("/api/accounts/recovery-pack", (req, res) => {
  const accounts = read(accountsFile);
  res.json({
    ok: true,
    count: accounts.length,
    backups: accounts.map((item) => ({
      igUserId: String(item.igUserId),
      label: item.label,
      backupBlob: makeBackupBlob(item)
    }))
  });
});

app.post("/api/accounts/restore", async (req, res) => {
  const blobs = Array.isArray(req.body?.backups) ? req.body.backups : [];
  if (!blobs.length) return res.json({ ok: true, restored: 0 });
  const accounts = read(accountsFile);
  let restored = 0;
  for (const blob of blobs.slice(0, 30)) {
    try {
      const data = JSON.parse(decrypt(String(blob)));
      if (!data?.igUserId || !data?.label || !data?.tokenEnc) continue;
      const ig = String(data.igUserId).trim();
      if (accounts.some(a => String(a.igUserId).trim() === ig)) continue;
      // Verify nested encrypted token is still decryptable with the current APP_SECRET_KEY.
      decrypt(data.tokenEnc);
      accounts.push({ id: newId(), label: String(data.label).replace(/^@/, "").trim(), igUserId: ig, tokenEnc: data.tokenEnc, createdAt: new Date().toISOString(), restoredAt: new Date().toISOString() });
      restored++;
    } catch (_) {}
  }
  if (restored) { await write(accountsFile, accounts); await persistence?.flush?.(); }
  res.json({ ok: true, restored });
});

app.post("/api/accounts", async (req, res) => {
  const { label, igUserId, accessToken } = req.body || {};
  if (!label || !igUserId || !accessToken) return res.status(400).json({ error: "label, igUserId and accessToken are required" });
  const accounts = read(accountsFile);
  const normalizedIgUserId = String(igUserId).trim();
  if (accounts.some((a) => String(a.igUserId).trim() === normalizedIgUserId)) return res.status(409).json({ error: "This Instagram account is already connected." });
  const item = { id: newId(), label: String(label).replace(/^@/, "").trim(), igUserId: normalizedIgUserId, tokenEnc: encrypt(String(accessToken).trim()), createdAt: new Date().toISOString() };
  accounts.push(item); await write(accountsFile, accounts);
  await persistence?.flush?.();
  res.json({ id: item.id, label: item.label, igUserId: item.igUserId, backupBlob: makeBackupBlob(item) });
});

app.delete("/api/accounts/:id", async (req, res) => {
  const accounts = read(accountsFile);
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: "Account not found." });
  const jobs = read(jobsFile);
  const active = jobs.some((j) => j.accountId === account.id && ["scheduled", "processing", "ready", "publishing", "retry_wait"].includes(j.status));
  if (active) return res.status(409).json({ error: "Finish this account's active jobs before removing it." });
  await write(accountsFile, accounts.filter((a) => a.id !== account.id));
  await persistence?.flush?.();
  res.json({ ok: true, removedId: account.id });
});

app.get("/api/scheduler/status", (req, res) => {
  const jobs = read(jobsFile);
  const now = Date.now();
  const active = jobs.filter(j => ACTIVE_QUEUE_STATUSES.has(j.status));
  const overdue = active.filter(j => new Date(j.scheduledAt).getTime() < now - LATE_JOB_GRACE_MS).length;
  res.json({
    ok: true,
    paused: Boolean(schedulerControl.paused),
    pausedAt: schedulerControl.pausedAt || null,
    resumedAt: schedulerControl.resumedAt || null,
    activeJobs: active.length,
    overdueJobs: overdue,
    catchupProtection: true,
    lateGraceSeconds: LATE_JOB_GRACE_MS / 1000,
    catchupStartDelaySeconds: CATCHUP_START_DELAY_MS / 1000,
    pattern: { burstSize: BURST_SIZE, gapMinutes: BURST_GAP_MINUTES, breakMinutes: BURST_BREAK_MINUTES }
  });
});

app.post("/api/scheduler/pause", async (req, res) => {
  if (!schedulerControl.paused) {
    schedulerControl.paused = true;
    schedulerControl.pausedAt = new Date().toISOString();
    await saveSchedulerControl();
  }
  res.json({ ok: true, paused: true, pausedAt: schedulerControl.pausedAt });
});

app.post("/api/scheduler/resume", async (req, res) => {
  const now = Date.now();
  const jobs = read(jobsFile);
  let shifted = 0;
  if (schedulerControl.paused && schedulerControl.pausedAt) {
    const pauseStarted = new Date(schedulerControl.pausedAt).getTime();
    const pauseDuration = Number.isFinite(pauseStarted) ? Math.max(0, now - pauseStarted) : 0;
    if (pauseDuration > 0) {
      for (const job of jobs) {
        if (!ACTIVE_QUEUE_STATUSES.has(job.status)) continue;
        const t = new Date(job.scheduledAt).getTime();
        if (Number.isFinite(t)) {
          job.scheduledAt = new Date(t + pauseDuration).toISOString();
          if (job.nextAttemptAt) {
            const n = new Date(job.nextAttemptAt).getTime();
            if (Number.isFinite(n)) job.nextAttemptAt = new Date(n + pauseDuration).toISOString();
          }
          shifted++;
        }
      }
    }
  }
  const rebased = rebaseLateBacklog(jobs, now, "manual_resume_catchup");
  if (shifted || rebased) { await write(jobsFile, jobs); await persistence?.flush?.(); }
  schedulerControl.paused = false;
  schedulerControl.pausedAt = null;
  schedulerControl.resumedAt = new Date().toISOString();
  await saveSchedulerControl();
  res.json({ ok: true, paused: false, shiftedJobs: shifted, rebasedJobs: rebased, resumedAt: schedulerControl.resumedAt });
});

app.get("/api/jobs", (req, res) => res.json(read(jobsFile)));

// Lightweight dashboard payload for very large monthly queues. Older clients
// can keep using /api/jobs; v11.8/v15 use this endpoint so 20k+ jobs are not
// downloaded every few seconds.
app.get("/api/dashboard-state", (req, res) => {
  const jobs = read(jobsFile);
  const activeStatuses = new Set(["scheduled","processing","ready","publishing","retry_wait"]);
  const counts = {
    active: jobs.filter(j => activeStatuses.has(j.status)).length,
    published: jobs.filter(j => j.status === "published").length,
    failed: jobs.filter(j => j.status === "failed").length,
    total: jobs.length
  };
  const queue = jobs.filter(j => j.status !== "published")
    .sort((a,b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))
    .slice(0, 600);
  const published = jobs.filter(j => j.status === "published")
    .sort((a,b) => new Date(b.publishedAt || b.scheduledAt || 0) - new Date(a.publishedAt || a.scheduledAt || 0))
    .slice(0, 150);
  res.json({ ok:true, counts, jobs:[...queue, ...published], queueReturned:queue.length, publishedReturned:published.length, truncated:jobs.length > queue.length + published.length });
});


function clientDayWindow(tzOffsetMinutes = 0, nowMs = Date.now()) {
  const offset = Math.max(-14*60, Math.min(14*60, Number(tzOffsetMinutes || 0)));
  const shifted = new Date(nowMs + offset * 60_000);
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  const start = Date.UTC(y, m, d) - offset * 60_000;
  return { start, end: start + 86_400_000, offset };
}
function metricLatestNumber(insights, name) {
  const metric = (insights?.data || []).find(x => x?.name === name);
  const values = Array.isArray(metric?.values) ? metric.values : [];
  for (let i = values.length - 1; i >= 0; i--) {
    const n = Number(values[i]?.value);
    if (Number.isFinite(n)) return { value: n, at: values[i]?.end_time || null, values };
  }
  const direct = Number(metric?.total_value?.value);
  return Number.isFinite(direct) ? { value: direct, at: null, values: [] } : null;
}
function metricSeriesNumbers(insights, name) {
  const metric = (insights?.data || []).find(x => x?.name === name);
  return (Array.isArray(metric?.values) ? metric.values : [])
    .map(v => ({ value: Number(v?.value), at: v?.end_time || null }))
    .filter(v => Number.isFinite(v.value));
}

// Exact per-account published counts without making clients download the whole
// monthly queue. Read-only/additive: this endpoint never edits scheduled jobs.
app.get("/api/published-stats", (req, res) => {
  const jobs = read(jobsFile);
  const accounts = read(accountsFile);
  const { start, end, offset } = clientDayWindow(req.query.tzOffsetMinutes);
  const rows = accounts.map(account => {
    const published = jobs.filter(j => j.accountId === account.id && j.status === "published");
    const today = published.filter(j => {
      const t = new Date(j.publishedAt || j.scheduledAt || 0).getTime();
      return Number.isFinite(t) && t >= start && t < end;
    });
    const sorted = published.slice().sort((a,b)=>new Date(a.publishedAt||a.scheduledAt||0)-new Date(b.publishedAt||b.scheduledAt||0));
    return {
      accountId: account.id,
      igUserId: account.igUserId,
      label: account.label,
      today: today.length,
      total: published.length,
      firstPublishedAt: sorted[0]?.publishedAt || sorted[0]?.scheduledAt || null,
      lastPublishedAt: sorted.at(-1)?.publishedAt || sorted.at(-1)?.scheduledAt || null
    };
  });
  res.json({ ok:true, tzOffsetMinutes: offset, accounts: rows, todayTotal: rows.reduce((n,r)=>n+r.today,0), totalPublished: rows.reduce((n,r)=>n+r.total,0) });
});

// Optional follower-growth analytics. This endpoint is isolated from the
// scheduler and never edits scheduled jobs. v14.7 fixes the old baseline bug:
// Instagram's follower_count insight series must not be treated as an absolute
// historical follower total. Accurate growth tracking now uses an immutable,
// durable follower snapshot captured from the profile's followers_count field.
app.get("/api/account-analytics", async (req, res) => {
  const accountId = String(req.query.accountId || "").trim();
  const accounts = read(accountsFile);
  const account = accounts.find(a => String(a.id) === accountId);
  if (!account) return res.status(404).json({ error: "Account not found." });

  const jobs = read(jobsFile);
  const published = jobs.filter(j => j.accountId === account.id && j.status === "published");
  const sorted = published.slice().sort((a,b)=>new Date(a.publishedAt||a.scheduledAt||0)-new Date(b.publishedAt||b.scheduledAt||0));
  const firstPublishedAt = sorted[0]?.publishedAt || sorted[0]?.scheduledAt || null;
  const { start: todayStart, end: todayEnd } = clientDayWindow(req.query.tzOffsetMinutes);
  const todayPublished = published.filter(j => {
    const t = new Date(j.publishedAt || j.scheduledAt || 0).getTime();
    return Number.isFinite(t) && t >= todayStart && t < todayEnd;
  }).length;

  const token = decrypt(account.tokenEnc);
  let profile = null, profileError = null;
  try {
    profile = await graph(`${account.igUserId}`, { fields: "username,followers_count,follows_count,media_count" }, token, "GET");
  } catch (e) { profileError = e; }

  // Reach/profile views remain historical Meta Insights metrics. follower_count
  // is intentionally NOT used for the baseline because its day-series values
  // are not a reliable absolute follower snapshot for this purpose.
  let insights = null, insightsError = null;
  const now = Date.now();
  const earliestAllowed = now - 89 * 86_400_000;
  const firstMs = firstPublishedAt ? new Date(firstPublishedAt).getTime() : now;
  const sinceMs = Math.max(Number.isFinite(firstMs) ? firstMs : now, earliestAllowed);
  try {
    insights = await graph(`${account.igUserId}/insights`, {
      metric: "reach,profile_views",
      period: "day",
      since: Math.floor(sinceMs / 1000),
      until: Math.floor(now / 1000)
    }, token, "GET");
  } catch (e) { insightsError = e; }

  const reachLatest = metricLatestNumber(insights, "reach");
  const profileViewsLatest = metricLatestNumber(insights, "profile_views");
  let currentFollowers = Number(profile?.followers_count);
  if (!Number.isFinite(currentFollowers)) currentFollowers = null;

  // v2 baseline namespace deliberately ignores the old v14.6 baseline logic.
  // A baseline is written exactly once per connected account and survives
  // Render restarts/redeploys through the existing durable Postgres layer.
  let baselines = {};
  try { baselines = (await persistence?.get?.("analytics_baselines_v2")) || {}; } catch (_) {}
  if (!baselines || typeof baselines !== "object" || Array.isArray(baselines)) baselines = {};

  let baselineFollowers = null, baselineAt = null, baselineSource = null;
  const saved = baselines[account.id];
  if (saved && Number.isFinite(Number(saved.followers)) && Number(saved.followers) > 0) {
    baselineFollowers = Number(saved.followers);
    baselineAt = saved.at || null;
    baselineSource = "durable_tracking_baseline_v2";
  } else if (Number.isFinite(currentFollowers)) {
    baselineFollowers = currentFollowers;
    baselineAt = new Date().toISOString();
    baselineSource = "tracking_started_v14_7";
    baselines[account.id] = {
      followers: currentFollowers,
      at: baselineAt,
      igUserId: account.igUserId,
      label: account.label || null,
      firstPublishedAt: firstPublishedAt || null
    };
    try { await persistence?.set?.("analytics_baselines_v2", baselines); } catch (_) {}
  }

  // Keep lightweight durable samples so the dashboard can show change since
  // the previous successful analytics check without affecting the scheduler.
  let samples = {};
  try { samples = (await persistence?.get?.("analytics_follower_samples_v2")) || {}; } catch (_) {}
  if (!samples || typeof samples !== "object" || Array.isArray(samples)) samples = {};
  const accountSamples = Array.isArray(samples[account.id]) ? samples[account.id] : [];
  const previousSample = accountSamples.length ? accountSamples[accountSamples.length - 1] : null;
  let followersChangeSinceLastCheck = null;
  if (Number.isFinite(currentFollowers) && previousSample && Number.isFinite(Number(previousSample.followers))) {
    followersChangeSinceLastCheck = currentFollowers - Number(previousSample.followers);
  }
  if (Number.isFinite(currentFollowers)) {
    const last = accountSamples[accountSamples.length - 1];
    // Avoid writing duplicate samples for repeated refreshes within 15 minutes
    // when the follower count is unchanged.
    const shouldAppend = !last || Number(last.followers) !== currentFollowers || (now - new Date(last.at || 0).getTime()) >= 15 * 60_000;
    if (shouldAppend) {
      accountSamples.push({ followers: currentFollowers, at: new Date().toISOString() });
      samples[account.id] = accountSamples.slice(-500);
      try { await persistence?.set?.("analytics_follower_samples_v2", samples); } catch (_) {}
    }
  }

  const followersGain = Number.isFinite(currentFollowers) && Number.isFinite(baselineFollowers)
    ? currentFollowers - baselineFollowers
    : null;
  const permissionNeeded = Boolean(insightsError) && /permission|insight|scope|access/i.test(String(insightsError.message || insightsError));

  let note = "";
  if (baselineSource === "tracking_started_v14_7") {
    note = "Accurate follower tracking starts from this snapshot because an absolute follower baseline was not stored before v14.7.";
  } else if (baselineSource === "durable_tracking_baseline_v2") {
    note = `Follower gain is tracked from the durable baseline saved at ${baselineAt || "the first v14.7 analytics check"}.`;
  }
  if (permissionNeeded) note += `${note ? " " : ""}For reach/profile insights, add instagram_business_manage_insights and reconnect/regenerate the Instagram token.`;
  if (!currentFollowers && profileError) note += `${note ? " " : ""}${profileError.message}`;

  res.json({
    ok: true,
    accountId: account.id,
    label: account.label,
    firstPublishedAt,
    todayPublished,
    totalPublished: published.length,
    currentFollowers,
    baselineFollowers,
    baselineAt,
    baselineSource,
    followersGain,
    followersChangeSinceLastCheck,
    currentMediaCount: Number.isFinite(Number(profile?.media_count)) ? Number(profile.media_count) : null,
    reachToday: reachLatest?.value ?? null,
    profileViewsToday: profileViewsLatest?.value ?? null,
    insightsPermissionNeeded: permissionNeeded,
    insightsError: insightsError ? String(insightsError.message || insightsError) : null,
    note
  });
});

// Read-only baseline inspection endpoint for debugging/dashboard use.
app.get("/api/analytics-baselines", async (req, res) => {
  let baselines = {};
  try { baselines = (await persistence?.get?.("analytics_baselines_v2")) || {}; } catch (_) {}
  res.json({ ok: true, baselines });
});

// Summaries for long-running Monthly Smart 24H plans. The actual schedule is
// still stored on each job, so the plan survives restarts with the same durable
// Postgres persistence as the rest of the queue.
app.get("/api/monthly-plans", (req, res) => {
  const jobs = read(jobsFile).filter(j => j.planId && j.scheduleKind === "monthly_smart");
  const groups = new Map();
  for (const job of jobs) {
    if (!groups.has(job.planId)) groups.set(job.planId, {
      planId: job.planId,
      startDate: job.planStartDate || null,
      endDate: job.planEndDate || null,
      dailyLimit: Number(job.planDailyLimit || 0),
      accountCount: 0,
      accounts: new Set(),
      jobs: 0,
      scheduled: 0,
      published: 0,
      failed: 0,
      firstScheduledAt: null,
      lastScheduledAt: null,
      createdAt: job.createdAt || null
    });
    const g = groups.get(job.planId);
    g.jobs++;
    g.accounts.add(job.accountId);
    if (job.status === "published") g.published++;
    else if (job.status === "failed") g.failed++;
    else if (["scheduled","processing","ready","publishing","retry_wait"].includes(job.status)) g.scheduled++;
    const t = new Date(job.scheduledAt).getTime();
    if (Number.isFinite(t)) {
      if (!g.firstScheduledAt || t < new Date(g.firstScheduledAt).getTime()) g.firstScheduledAt = job.scheduledAt;
      if (!g.lastScheduledAt || t > new Date(g.lastScheduledAt).getTime()) g.lastScheduledAt = job.scheduledAt;
    }
  }
  const out = [...groups.values()].map(g => ({...g, accountCount: g.accounts.size, accounts: undefined})).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0));
  res.json({ ok: true, plans: out });
});

// Manually remove a queued job. We intentionally block jobs that are actively
// processing/publishing or already published so a user cannot interrupt a Meta
// API transaction halfway through.
app.delete("/api/jobs/:id", async (req, res) => {
  const jobs = read(jobsFile);
  const index = jobs.findIndex((j) => j.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Job not found." });
  const job = jobs[index];
  if (["processing", "publishing", "published"].includes(job.status)) {
    return res.status(409).json({ error: `Cannot delete a ${job.status} job.` });
  }
  const [removed] = jobs.splice(index, 1);
  await write(jobsFile, jobs);
  await persistence?.flush?.();

  // Remove media only when no other job references the same object.
  if (removed.mediaUrl && !jobs.some((j) => j.mediaUrl === removed.mediaUrl)) {
    mediaStore.remove(removed).catch(() => {});
  }
  res.json({ ok: true, deleted: removed.id });
});

// Ignore the original schedule for one job and move it to the front of the
// normal smart-rate-limit queue. It still respects Meta throttling/backoff.
app.post("/api/jobs/:id/post-now", async (req, res) => {
  const jobs = read(jobsFile);
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (["processing", "publishing", "published"].includes(job.status)) {
    return res.status(409).json({ error: `Cannot Post Now while job is ${job.status}.` });
  }
  job.scheduledAt = new Date().toISOString();
  job.nextAttemptAt = null;
  job.error = null;
  job.lastErrorType = null;
  // If a container already exists and was ready, publish on the next scheduler
  // pass; otherwise resume preparation/checking without creating duplicates.
  if (job.status === "ready") {
    job.status = "ready";
  } else if (job.containerId) {
    job.status = "processing";
  } else {
    job.status = "scheduled";
  }
  await write(jobsFile, jobs);
  await persistence?.flush?.();
  res.json({ ok: true, id: job.id, status: job.status, scheduledAt: job.scheduledAt });
});

app.post("/api/schedule", requireSafeStorage, upload.array("videos", 10), async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) throw new Error("At least one video is required.");
    const cfg = JSON.parse(req.body.config || "{}");
    const accounts = read(accountsFile);
    const selected = (cfg.accountIds || []).map((accountId) => accounts.find((a) => a.id === accountId)).filter(Boolean);
    if (!selected.length) throw new Error("No valid accounts selected.");
    if (selected.length > 15) throw new Error("Maximum 15 accounts per batch.");
    if (files.length > 10) throw new Error("Maximum 10 videos per upload chunk.");

    const totalJobs = files.length * selected.length;
    if (totalJobs > 150) throw new Error("Maximum 150 generated posts per upload chunk.");

    const now = Date.now();
    let scheduleTimes = [];
    if (cfg.mode === "explicit") {
      if (!Array.isArray(cfg.explicitTimes) || cfg.explicitTimes.length !== totalJobs) throw new Error("Explicit schedule count does not match generated jobs.");
      scheduleTimes = cfg.explicitTimes.map((v) => { const t = new Date(v).getTime(); if (!Number.isFinite(t)) throw new Error("Invalid explicit schedule time."); return t; });
    } else if (cfg.mode === "random") {
      let start = new Date(cfg.startAt).getTime();
      const end = new Date(cfg.endAt).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Invalid random time window.");
      start = Math.max(start, now);
      if (end <= now) throw new Error("Random window has already ended.");
      scheduleTimes = generateTimes(totalJobs, start, end, Number(cfg.minGapMinutes || 0));
    } else {
      let fixed = new Date(cfg.fixedAt).getTime();
      if (!Number.isFinite(fixed)) throw new Error("Invalid fixed time.");
      // datetime-local has minute precision. If the chosen current minute is already a few seconds old,
      // treat it as NOW instead of shifting it into the future or rejecting it.
      if (fixed < now - 90_000) throw new Error("Fixed time is too far in the past.");
      if (fixed <= now + 5_000) fixed = now;
      const gap = Math.max(0, Number(cfg.minGapMinutes || 0)) * 60_000;
      scheduleTimes = Array.from({ length: totalJobs }, (_, i) => fixed + i * gap);
    }

    // Idempotency for resumable/background uploads: if a client retries a chunk
    // after the backend already created every matching job, do not duplicate it.
    const jobs = read(jobsFile);
    const scheduleIso = scheduleTimes.map(t => new Date(t).toISOString());
    const existingKeys = new Set(jobs.filter(j => j.batchId === (cfg.batchId || "")).map(j => `${j.accountId}|${j.fileName}|${j.scheduledAt}`));
    if (cfg.batchId) {
      const expected = [];
      let ei = 0;
      for (const file of files) for (const account of selected) expected.push(`${account.id}|${file.originalname}|${scheduleIso[ei++]}`);
      if (expected.length && expected.every(k => existingKeys.has(k))) {
        for (const file of files) if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.json({ ok:true, created:0, deduped:expected.length, videos:files.length, accounts:selected.length, firstScheduledAt:scheduleIso[0], lastScheduledAt:scheduleIso[scheduleIso.length-1] });
      }
    }

    const base = publicBaseUrl(req);
    const storedFiles = [];
    for (const file of files) {
      const stored = await mediaStore.put(file, file.originalname, base);
      storedFiles.push({ originalname: file.originalname, mediaUrl: stored.mediaUrl, storageKey: stored.storageKey || null });
    }

    const batchId = cfg.batchId || newId();
    let index = 0, createdCount = 0;
    const perVideoCaptions = Array.isArray(cfg.captions) ? cfg.captions.map((v) => String(v ?? "").slice(0, 2200)) : [];
    let fileIndex = 0;
    // Every selected video is scheduled to every selected account.
    for (const file of storedFiles) {
      const fileCaption = (perVideoCaptions[fileIndex] !== undefined ? perVideoCaptions[fileIndex] : String(cfg.caption || "")).slice(0, 2200);
      for (const account of selected) {
        const scheduledAt = scheduleIso[index++];
        const dedupeKey = `${account.id}|${file.originalname}|${scheduledAt}`;
        if (cfg.batchId && existingKeys.has(dedupeKey)) continue;
        jobs.push({
          id: newId(),
          batchId,
          accountId: account.id,
          accountLabel: account.label,
          igUserId: account.igUserId,
          fileName: file.originalname,
          mediaUrl: file.mediaUrl,
          storageKey: file.storageKey || null,
          caption: fileCaption,
          scheduledAt,
          status: "scheduled",
          createdAt: new Date().toISOString(),
          error: null,
          containerId: null,
          preparedAt: null,
          publishedMediaId: null,
          permalink: null,
          permalinkFetchedAt: null,
          retryCount: 0,
          nextAttemptAt: null,
          lastAttemptAt: null,
          lastErrorType: null,
          scheduleKind: String(cfg.scheduleKind || "standard"),
          planId: cfg.planId ? String(cfg.planId) : null,
          planStartDate: cfg.monthlyPlan?.startDate ? String(cfg.monthlyPlan.startDate) : null,
          planEndDate: cfg.monthlyPlan?.endDate ? String(cfg.monthlyPlan.endDate) : null,
          planDailyLimit: cfg.monthlyPlan?.dailyLimit ? Number(cfg.monthlyPlan.dailyLimit) : null
        });
        createdCount++;
      }
      fileIndex++;
    }

    await write(jobsFile, jobs);
    await persistence?.flush?.();
    res.json({ ok: true, created: createdCount, deduped: totalJobs-createdCount, videos: files.length, accounts: selected.length, firstScheduledAt: scheduleIso[0], lastScheduledAt: scheduleIso[scheduleIso.length - 1] });
  } catch (error) {
    for (const file of req.files || []) if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    res.status(400).json({ error: error.message });
  }
});

function isRateLimitError(message) {
  return /request limit|rate limit|too many|temporarily blocked|try again later|throttl/i.test(String(message || ""));
}

function retryDelayMs(retryCount, rateLimited = false) {
  if (rateLimited) return Math.min(6 * 60 * 60_000, RATE_LIMIT_BACKOFF_MS * Math.max(1, Math.pow(2, Math.min(retryCount - 1, 3))));
  return Math.min(60 * 60_000, 2 * 60_000 * Math.max(1, Math.pow(2, Math.min(retryCount - 1, 5))));
}

app.post("/api/jobs/:id/retry", async (req, res) => {
  const jobs = read(jobsFile);
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "failed") return res.status(409).json({ error: "Only failed jobs can be retried manually." });
  job.status = job.containerId ? "processing" : "scheduled";
  job.error = null;
  job.lastErrorType = null;
  job.nextAttemptAt = new Date(Date.now() + 15_000).toISOString();
  job.retryCount = 0;
  await write(jobsFile, jobs);
  await persistence?.flush?.();
  res.json({ ok: true, id: job.id, status: job.status });
});

app.post("/api/jobs/retry-failed", async (req, res) => {
  const jobs = read(jobsFile);
  let count = 0;
  for (const job of jobs) {
    if (job.status !== "failed") continue;
    job.status = job.containerId ? "processing" : "scheduled";
    job.error = null;
    job.lastErrorType = null;
    job.nextAttemptAt = new Date(Date.now() + 15_000 + count * 1000).toISOString();
    job.retryCount = 0;
    count++;
  }
  if (count) { await write(jobsFile, jobs); await persistence?.flush?.(); }
  res.json({ ok: true, retried: count });
});

async function graph(pathname, params, token, method = "POST") {
  const url = new URL(`https://graph.instagram.com/${GRAPH}/${pathname}`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, String(value));
  url.searchParams.set("access_token", token);
  const response = await fetch(url, { method });
  const json = await response.json();
  if (!response.ok || json.error) throw new Error(json.error?.message || `Meta API HTTP ${response.status}`);
  return json;
}

async function createContainer(job, account) {
  const token = decrypt(account.tokenEnc);
  const created = await graph(`${account.igUserId}/media`, { media_type: "REELS", video_url: job.mediaUrl, caption: job.caption, share_to_feed: "true" }, token);
  return created.id;
}

async function checkContainer(job, account) {
  const token = decrypt(account.tokenEnc);
  return graph(job.containerId, { fields: "status_code,status" }, token, "GET");
}

async function publishContainer(job, account) {
  const token = decrypt(account.tokenEnc);
  const published = await graph(`${account.igUserId}/media_publish`, { creation_id: job.containerId }, token);
  return published.id;
}

async function fetchPublishedPermalink(job, account) {
  if (!job.publishedMediaId) return null;
  const token = decrypt(account.tokenEnc);
  const media = await graph(job.publishedMediaId, { fields: "permalink" }, token, "GET");
  return media.permalink || null;
}

let busy = false;
let lastMetaRequestAt = 0;
let globalBackoffUntil = 0;

function eligibleAt(job, now) {
  if (job.nextAttemptAt && new Date(job.nextAttemptAt).getTime() > now) return false;
  return true;
}

function markRetry(job, error, rateLimited) {
  job.retryCount = Number(job.retryCount || 0) + 1;
  job.error = error.message;
  job.lastErrorType = rateLimited ? "rate_limit" : "transient";
  if (job.retryCount > MAX_AUTO_RETRIES) {
    job.status = "failed";
    job.nextAttemptAt = null;
    return;
  }
  const delay = retryDelayMs(job.retryCount, rateLimited);
  job.status = "retry_wait";
  job.nextAttemptAt = new Date(Date.now() + delay).toISOString();
  if (rateLimited) globalBackoffUntil = Math.max(globalBackoffUntil, Date.now() + delay);
}

async function runSchedulerUnlocked() {
  if (busy) return;
  if (schedulerControl.paused) return;
  const now = Date.now();
  if (now < globalBackoffUntil) return;
  if (now - lastMetaRequestAt < META_MIN_REQUEST_INTERVAL_MS) return;
  busy = true;
  try {
    const accounts = read(accountsFile);
    const jobs = read(jobsFile);
    let changed = false;

    // Render Free can sleep. If the service wakes with old overdue jobs, never
    // dump the backlog immediately. Rebuild each affected account timeline from
    // now using the configured 5x10-minute + 1-hour-break burst pattern.
    const rebasedLate = rebaseLateBacklog(jobs, now, "automatic_wake_catchup");
    if (rebasedLate) changed = true;

    // Wake retry jobs only when their backoff has elapsed.
    for (const job of jobs) {
      if (job.status === "retry_wait" && eligibleAt(job, now)) {
        job.status = job.containerId ? "processing" : "scheduled";
        job.nextAttemptAt = null;
        changed = true;
      }
    }

    // Do at most ONE Meta API action per scheduler pass. This deliberately
    // trades speed for compliance and prevents bursts when hundreds of jobs exist.
    const ordered = jobs
      .filter(j => !["failed", "retry_wait"].includes(j.status) && eligibleAt(j, now) && (j.status !== "published" || (j.publishedMediaId && !j.permalink)))
      .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));

    for (const job of ordered) {
      const account = accounts.find(a => a.id === job.accountId);
      if (!account) {
        job.status = "failed";
        job.error = "Connected account not found.";
        changed = true;
        continue;
      }
      const dueAt = new Date(job.scheduledAt).getTime();
      let action = null;
      if (job.status === "scheduled" && dueAt - now <= PREPARE_AHEAD_MS) action = "create";
      else if (job.status === "processing" && job.containerId) action = "check";
      else if (job.status === "ready" && dueAt <= now) action = "publish";
      else if (job.status === "published" && job.publishedMediaId && !job.permalink) action = "permalink";
      if (!action) continue;

      try {
        job.lastAttemptAt = new Date().toISOString();
        lastMetaRequestAt = Date.now();
        if (action === "create") {
          job.containerId = await createContainer(job, account);
          job.status = "processing";
          job.preparedAt = new Date().toISOString();
          job.error = null;
          job.lastErrorType = null;
        } else if (action === "check") {
          const state = await checkContainer(job, account);
          if (state.status_code === "FINISHED") {
            job.status = "ready";
            job.readyAt = new Date().toISOString();
            job.error = null;
            job.lastErrorType = null;
          } else if (state.status_code === "ERROR" || state.status_code === "EXPIRED") {
            // A broken/expired container can be recreated on a later attempt.
            job.containerId = null;
            throw new Error(`Instagram container status: ${state.status_code}`);
          } else {
            // Poll slowly; do not hammer container status endpoints.
            job.nextAttemptAt = new Date(Date.now() + 30_000).toISOString();
          }
        } else if (action === "publish") {
          job.status = "publishing";
          await write(jobsFile, jobs);
          await persistence?.flush?.();
          job.publishedMediaId = await publishContainer(job, account);
          job.status = "published";
          job.publishedAt = new Date().toISOString();
          job.error = null;
          job.lastErrorType = null;
          job.nextAttemptAt = null;
        } else if (action === "permalink") {
          job.permalink = await fetchPublishedPermalink(job, account);
          job.permalinkFetchedAt = new Date().toISOString();
          job.nextAttemptAt = null;
        }
        changed = true;
      } catch (error) {
        const rateLimited = isRateLimitError(error.message);
        markRetry(job, error, rateLimited);
        changed = true;
      }
      break;
    }

    if (changed) { await write(jobsFile, jobs); await persistence?.flush?.(); }
  } finally {
    busy = false;
  }
}

async function runScheduler() {
  if (!persistence?.withSchedulerLock) return runSchedulerUnlocked();
  return persistence.withSchedulerLock(runSchedulerUnlocked);
}

async function cleanupPublishedMedia() {
  if (KEEP_MEDIA_AFTER_PUBLISH_HOURS < 0) return;
  const jobs = read(jobsFile);
  const cutoff = Date.now() - KEEP_MEDIA_AFTER_PUBLISH_HOURS * 60 * 60_000;
  let changed = false;
  for (const job of jobs) {
    if (job.status !== "published" || !job.publishedAt || !job.storageKey || job.mediaDeletedAt) continue;
    if (new Date(job.publishedAt).getTime() > cutoff) continue;
    // Only remove an object when all jobs referencing it are already published.
    const siblings = jobs.filter(j => j.mediaUrl === job.mediaUrl);
    if (!siblings.every(j => j.status === "published")) continue;
    try {
      await mediaStore.remove(job);
      for (const sibling of siblings) {
        sibling.mediaDeletedAt = new Date().toISOString();
        sibling.storageKey = null;
      }
      changed = true;
    } catch (e) {
      console.error("Media cleanup failed:", e.message);
    }
  }
  if (changed) { await write(jobsFile, jobs); await persistence?.flush?.(); }
}

setInterval(runScheduler, 5_000);
setInterval(() => cleanupPublishedMedia().catch(e => console.error("Cleanup error:", e.message)), 30 * 60_000);
runScheduler();
cleanupPublishedMedia().catch(() => {});

async function gracefulShutdown(signal) {
  console.log(`${signal}: flushing persistent state...`);
  try { await persistence?.flush?.(); await persistence?.close?.(); } catch (_) {}
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

app.listen(PORT, "0.0.0.0", () => console.log(`Insta Auto Publisher v14.7 analytics-baseline-fix backend running on port ${PORT}`));
