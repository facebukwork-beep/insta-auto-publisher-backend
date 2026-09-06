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
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", GDRIVE_CLIENT_ID);
  u.searchParams.set("redirect_uri", driveOAuthRedirectUri(req));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "https://www.googleapis.com/auth/drive.file");
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", makeDriveOAuthState());
  res.redirect(u.toString());
});

app.get("/api/google-drive/oauth/callback", async (req, res) => {
  try {
    if (!verifyDriveOAuthState(req.query.state)) return res.status(400).send("Invalid or expired OAuth state. Start again from /api/google-drive/connect.");
    if (!req.query.code) return res.status(400).send(`Google authorization failed: ${req.query.error || "missing authorization code"}`);
    const body = new URLSearchParams({
      client_id: GDRIVE_CLIENT_ID,
      client_secret: GDRIVE_CLIENT_SECRET,
      code: String(req.query.code),
      grant_type: "authorization_code",
      redirect_uri: driveOAuthRedirectUri(req)
    });
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const text = await r.text();
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text }; }
    if (!r.ok) return res.status(400).send(`Google OAuth token exchange failed (${r.status}): ${j.error_description || j.error || j.raw || "unknown error"}`);
    if (!j.refresh_token && !driveRefreshToken) return res.status(400).send("Google did not return a refresh token. Revoke the app in your Google Account and connect again.");
    if (j.refresh_token) await saveDriveRefreshToken(j.refresh_token);
    res.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Drive connected</title><body style="font:16px system-ui;background:#08111f;color:#fff;padding:28px"><h1>✅ Google Drive connected</h1><p>The refresh token is now encrypted and saved in your durable Postgres state. You no longer need OAuth Playground or GDRIVE_REFRESH_TOKEN for this connection.</p><p><a style="color:#8ab4ff" href="/api/drive-test">Run Drive test</a></p></body>`);
  } catch (e) {
    res.status(500).send(`Drive OAuth callback failed: ${e.message}`);
  }
});

app.get("/api/google-drive/status", (req, res) => {
  res.json({ ok: true, configured: Boolean(GDRIVE_CLIENT_ID && GDRIVE_CLIENT_SECRET), connected: Boolean(driveRefreshToken), durableToken: Boolean(persistence?.durable), connectUrl: `${publicBaseUrl(req)}/api/google-drive/connect` });
});

app.get("/", (req, res) => {
  res.send("✅ Insta Auto Publisher Backend is Live");
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "insta-auto-publisher", version: "14.8.0", graphApi: GRAPH, storage: mediaStore.describe() });
});

app.get("/api/storage-status", (req, res) => {
  const media = mediaStore.describe();
  const statePersistent = Boolean(persistence?.durable || persistentRoot);
  const mediaPersistent = Boolean(media.persistent || persistentRoot);
  const restartSafe = statePersistent && mediaPersistent;
  const reasons = [];
  if (!statePersistent) reasons.push("State is local/ephemeral. Configure DATABASE_URL or PERSISTENT_ROOT.");
  if (!mediaPersistent) reasons.push("Media is local/ephemeral. Configure S3/R2 storage or PERSISTENT_ROOT.");
  res.json({
    ok: true,
    state: persistence?.describe?.() || (persistentRoot ? "disk" : "local"),
    media: media.type,
    persistentRoot: persistentRoot || null,
    statePersistent,
    mediaPersistent,
    restartSafe,
    reasons,
    safeToSchedule: restartSafe || !REQUIRE_RESTART_SAFE_STORAGE,
    requireRestartSafeStorage: REQUIRE_RESTART_SAFE_STORAGE,
    exactTimingWarning: "A sleeping web service can still delay exact-time publishing. Durable storage prevents data loss, not service sleep."
  });
});

app.get("/api/accounts", (req, res) => {
  res.json(read(accountsFile).map(a => ({ id: a.id, igUserId: a.igUserId, label: a.label, username: a.username || null, createdAt: a.createdAt })));
});

app.get("/api/accounts/recovery-export", (req, res) => {
  res.json({
    ok: true,
    exportedAt: new Date().toISOString(),
    accounts: read(accountsFile).map(a => ({ id: a.id, igUserId: a.igUserId, label: a.label, username: a.username || null, createdAt: a.createdAt, tokenEnc: a.tokenEnc }))
  });
});

app.post("/api/accounts/recovery-import", async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.accounts) ? req.body.accounts : [];
    const current = read(accountsFile);
    let restored = 0;
    for (const src of incoming) {
      if (!src?.igUserId || !src?.tokenEnc || !String(src.tokenEnc).includes(".")) continue;
      let valid = false;
      try { decrypt(src.tokenEnc); valid = true; } catch (_) {}
      if (!valid) continue;
      const duplicate = current.find(a => a.igUserId === String(src.igUserId).trim() || (src.id && a.id === src.id));
      if (duplicate) {
        duplicate.label = String(src.label || duplicate.label || src.igUserId).trim();
        duplicate.username = String(src.username || duplicate.username || "").trim() || null;
        duplicate.tokenEnc = src.tokenEnc;
      } else {
        current.push({ id: src.id || newId(), igUserId: String(src.igUserId).trim(), label: String(src.label || src.igUserId).trim(), username: String(src.username || "").trim() || null, tokenEnc: src.tokenEnc, createdAt: src.createdAt || new Date().toISOString() });
      }
      restored++;
    }
    await write(accountsFile, current);
    await persistence?.flush?.();
    res.json({ ok: true, restored, accounts: current.map(a => ({ id:a.id, igUserId:a.igUserId, label:a.label, username:a.username||null, createdAt:a.createdAt })) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/accounts", async (req, res) => {
  const { igUserId, label, accessToken } = req.body || {};
  if (!igUserId || !accessToken) return res.status(400).json({ error: "igUserId and accessToken are required." });
  const accounts = read(accountsFile);
  const cleanId = String(igUserId).trim();
  const existing = accounts.find(a => a.igUserId === cleanId);
  if (existing) {
    existing.label = String(label || existing.label || cleanId).trim();
    existing.tokenEnc = encrypt(String(accessToken).trim());
    existing.updatedAt = new Date().toISOString();
    await write(accountsFile, accounts);
    await persistence?.flush?.();
    return res.json({ id: existing.id, igUserId: existing.igUserId, label: existing.label, createdAt: existing.createdAt, updated: true });
  }
  if (accounts.length >= 15) return res.status(400).json({ error: "Maximum 15 accounts are supported." });
  const account = { id: newId(), igUserId: cleanId, label: String(label || cleanId).trim(), tokenEnc: encrypt(String(accessToken).trim()), createdAt: new Date().toISOString() };
  accounts.push(account);
  await write(accountsFile, accounts);
  await persistence?.flush?.();
  res.json({ id: account.id, igUserId: account.igUserId, label: account.label, createdAt: account.createdAt });
});

app.delete("/api/accounts/:id", async (req, res) => {
  let accounts = read(accountsFile);
  const before = accounts.length;
  accounts = accounts.filter(a => a.id !== req.params.id);
  if (accounts.length === before) return res.status(404).json({ error: "Account not found." });
  await write(accountsFile, accounts);
  await persistence?.flush?.();
  res.json({ ok: true });
});

function jobPublic(j) {
  return {
    id: j.id, accountId: j.accountId, accountLabel: j.accountLabel, videoName: j.videoName,
    caption: j.caption || "", scheduledAt: j.scheduledAt, status: j.status, error: j.error || null,
    permalink: j.permalink || null, publishedAt: j.publishedAt || null,
    retryCount: Number(j.retryCount || 0), nextAttemptAt: j.nextAttemptAt || null,
    lastErrorType: j.lastErrorType || null, publishedMediaId: j.publishedMediaId || null,
    createdAt: j.createdAt || null, preparedAt: j.preparedAt || null,
    batchId: j.batchId || null, sourceUploadId: j.sourceUploadId || null,
    scheduleMode: j.scheduleMode || null, monthlyDay: j.monthlyDay || null,
    monthlyDayIndex: Number.isFinite(Number(j.monthlyDayIndex)) ? Number(j.monthlyDayIndex) : null,
    catchupReason: j.catchupReason || null, catchupRebasedAt: j.catchupRebasedAt || null
  };
}

app.get("/api/jobs", (req, res) => {
  res.json(read(jobsFile).slice().sort((a,b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)).map(jobPublic));
});

app.get("/api/jobs/published", (req, res) => {
  res.json(read(jobsFile).filter(j => j.status === "published").slice().sort((a,b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).map(jobPublic));
});

function parseTzOffsetMinutes(value) {
  const n = Number(value);
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? Math.trunc(n) : 330;
}
function shiftedDateKey(value, offsetMinutes) {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

app.get("/api/published-stats", (req, res) => {
  try {
    const tzOffsetMinutes = parseTzOffsetMinutes(req.query.tzOffsetMinutes);
    const todayKey = shiftedDateKey(Date.now(), tzOffsetMinutes);
    const accounts = read(accountsFile);
    const published = read(jobsFile).filter(j => j.status === "published");
    const rows = accounts.map(a => {
      const own = published.filter(j => j.accountId === a.id);
      const dated = own.filter(j => j.publishedAt);
      const firstPublishedAt = dated.length ? dated.reduce((m,j)=> !m || new Date(j.publishedAt)<new Date(m) ? j.publishedAt : m, null) : null;
      const lastPublishedAt = dated.length ? dated.reduce((m,j)=> !m || new Date(j.publishedAt)>new Date(m) ? j.publishedAt : m, null) : null;
      return {
        accountId: a.id, igUserId: a.igUserId, label: a.label,
        today: dated.filter(j => shiftedDateKey(j.publishedAt, tzOffsetMinutes) === todayKey).length,
        total: own.length, firstPublishedAt, lastPublishedAt
      };
    });
    res.json({ ok:true, tzOffsetMinutes, accounts: rows, todayTotal: rows.reduce((s,r)=>s+r.today,0), totalPublished: rows.reduce((s,r)=>s+r.total,0) });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

async function instagramAccountProfile(account) {
  const token = decrypt(account.tokenEnc);
  return graph(`${account.igUserId}`, { fields: "username,followers_count,media_count" }, token, "GET");
}
async function instagramDailyInsight(account, metric, sinceSec, untilSec) {
  const token = decrypt(account.tokenEnc);
  try {
    const j = await graph(`${account.igUserId}/insights`, { metric, period:"day", since: sinceSec, until: untilSec }, token, "GET");
    return j?.data?.[0]?.values || [];
  } catch (e) {
    return { __error: e.message };
  }
}
function normalizeFollowerHistoryValues(values) {
  if (!Array.isArray(values)) return [];
  return values.map(v => ({ end_time:v?.end_time || null, value:Number(v?.value) })).filter(v => v.end_time && Number.isFinite(v.value));
}
function mostRecentAbsoluteFollowerValue(values, beforeIso) {
  const before = beforeIso ? new Date(beforeIso).getTime() : Date.now();
  const clean = normalizeFollowerHistoryValues(values).filter(v => new Date(v.end_time).getTime() <= before).sort((a,b)=>new Date(b.end_time)-new Date(a.end_time));
  return clean[0] || null;
}
function sumInsightValues(values) {
  if (!Array.isArray(values)) return null;
  const nums = values.map(v=>Number(v?.value)).filter(Number.isFinite);
  return nums.length ? nums.reduce((a,b)=>a+b,0) : null;
}
async function getAnalyticsBaselines() {
  try { return (await persistence?.get?.("analytics_baselines")) || {}; } catch (_) { return {}; }
}
async function saveAnalyticsBaselines(x) {
  if (persistence?.set) await persistence.set("analytics_baselines", x);
}
function validAbsoluteFollowerBaseline(x) {
  return Number.isFinite(Number(x)) && Number(x) > 0;
}

app.get("/api/account-analytics", async (req, res) => {
  try {
    const accountId = String(req.query.accountId || "").trim();
    const account = read(accountsFile).find(a=>a.id===accountId);
    if (!account) return res.status(404).json({ error:"Account not found." });
    const tzOffsetMinutes = parseTzOffsetMinutes(req.query.tzOffsetMinutes);
    const published = read(jobsFile).filter(j=>j.status==="published" && j.accountId===account.id);
    const dated = published.filter(j=>j.publishedAt);
    const firstPublishedAt = dated.length ? dated.reduce((m,j)=>!m||new Date(j.publishedAt)<new Date(m)?j.publishedAt:m,null) : null;
    const todayKey = shiftedDateKey(Date.now(), tzOffsetMinutes);
    const todayPublished = dated.filter(j=>shiftedDateKey(j.publishedAt,tzOffsetMinutes)===todayKey).length;
    const profile = await instagramAccountProfile(account);
    const currentFollowers = Number(profile?.followers_count);
    const currentMediaCount = Number(profile?.media_count);
    const nowSec = Math.floor(Date.now()/1000);
    const historyStartSec = Math.floor((Date.now()-29*86400_000)/1000);
    const localNow = Date.now()+tzOffsetMinutes*60_000;
    const dayStartShifted = new Date(new Date(localNow).toISOString().slice(0,10)+"T00:00:00.000Z").getTime();
    const todayStartSec = Math.floor((dayStartShifted-tzOffsetMinutes*60_000)/1000);
    const [reachValues, profileViewValues] = await Promise.all([
      instagramDailyInsight(account,"reach",todayStartSec,nowSec),
      instagramDailyInsight(account,"profile_views",todayStartSec,nowSec)
    ]);
    let insightsError = null;
    for (const x of [reachValues,profileViewValues]) if (x && !Array.isArray(x) && x.__error) insightsError = insightsError || x.__error;
    const baselines = await getAnalyticsBaselines();
    const previous = baselines[account.id] || null;
    let baselineFollowers = previous && validAbsoluteFollowerBaseline(previous.followers) ? Number(previous.followers) : null;
    let baselineAt = previous?.baselineAt || null;
    let baselineSource = previous?.source || null;
    if (!validAbsoluteFollowerBaseline(baselineFollowers)) {
      baselineFollowers = Number.isFinite(currentFollowers) && currentFollowers >= 0 ? currentFollowers : null;
      baselineAt = new Date().toISOString();
      baselineSource = "tracking_started_v14_7";
      if (validAbsoluteFollowerBaseline(baselineFollowers)) {
        baselines[account.id] = { followers: baselineFollowers, baselineAt, source: baselineSource, label: account.label };
        await saveAnalyticsBaselines(baselines);
      }
    }
    const followersGain = validAbsoluteFollowerBaseline(baselineFollowers) && Number.isFinite(currentFollowers) ? currentFollowers - Number(baselineFollowers) : null;
    res.json({
      ok:true, accountId:account.id, label:account.label, firstPublishedAt, todayPublished, totalPublished:published.length,
      currentFollowers:Number.isFinite(currentFollowers)?currentFollowers:null,
      baselineFollowers:validAbsoluteFollowerBaseline(baselineFollowers)?Number(baselineFollowers):null,
      baselineAt, baselineSource, followersGain,
      currentMediaCount:Number.isFinite(currentMediaCount)?currentMediaCount:null,
      reachToday:sumInsightValues(reachValues), profileViewsToday:sumInsightValues(profileViewValues),
      insightsPermissionNeeded:Boolean(insightsError && /permission|insufficient|unsupported|access/i.test(insightsError)), insightsError,
      note:"Accurate follower tracking starts from this snapshot because an absolute follower baseline was not stored before v14.7."
    });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.post("/api/account-analytics/reset-baseline", async (req, res) => {
  try {
    const accountId = String(req.body?.accountId || "").trim();
    const account = read(accountsFile).find(a=>a.id===accountId);
    if (!account) return res.status(404).json({ error:"Account not found." });
    const profile = await instagramAccountProfile(account);
    const currentFollowers = Number(profile?.followers_count);
    if (!validAbsoluteFollowerBaseline(currentFollowers)) return res.status(409).json({ error:"Instagram did not return a valid current follower count." });
    const baselines = await getAnalyticsBaselines();
    baselines[account.id] = { followers:currentFollowers, baselineAt:new Date().toISOString(), source:"manual_reset", label:account.label };
    await saveAnalyticsBaselines(baselines);
    res.json({ ok:true, accountId:account.id, baselineFollowers:currentFollowers, baselineAt:baselines[account.id].baselineAt });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get("/api/scheduler/control", (req, res) => {
  const jobs = read(jobsFile);
  const active = jobs.filter(j => ACTIVE_QUEUE_STATUSES.has(j.status));
  const now = Date.now();
  res.json({
    ok: true,
    paused: Boolean(schedulerControl.paused),
    pausedAt: schedulerControl.pausedAt || null,
    resumedAt: schedulerControl.resumedAt || null,
    activeJobs: active.length,
    overdueJobs: active.filter(j => new Date(j.scheduledAt).getTime() < now - LATE_JOB_GRACE_MS).length,
    catchupProtection: true
  });
});

app.post("/api/scheduler/pause", async (req, res) => {
  schedulerControl.paused = true;
  schedulerControl.pausedAt = new Date().toISOString();
  await saveSchedulerControl();
  await persistence?.flush?.();
  res.json({ ok: true, paused: true, pausedAt: schedulerControl.pausedAt });
});

app.post("/api/scheduler/resume", async (req, res) => {
  const jobs = read(jobsFile);
  const now = Date.now();
  const changed = rebaseLateBacklog(jobs, now, "manual_resume_catchup");
  if (changed) await write(jobsFile, jobs);
  schedulerControl.paused = false;
  schedulerControl.resumedAt = new Date().toISOString();
  await saveSchedulerControl();
  await persistence?.flush?.();
  res.json({ ok: true, paused: false, resumedAt: schedulerControl.resumedAt, rebasedJobs: changed });
});

app.post("/api/media/presign", async (req, res) => {
  try {
    const { videoName, mimeType, size } = req.body || {};
    if (!videoName) return res.status(400).json({ error: "videoName is required." });
    if (typeof mediaStore?.createBrowserUpload !== "function") return res.status(409).json({ error: "Direct browser upload is unavailable for the configured media store." });
    const uploadInfo = await mediaStore.createBrowserUpload({ videoName:String(videoName), mimeType:String(mimeType||"video/mp4"), size:Number(size||0) });
    res.json({ ok:true, ...uploadInfo });
  } catch (e) { res.status(400).json({ error:e.message }); }
});

app.post("/api/jobs/from-media", async (req, res) => {
  try {
    if (REQUIRE_RESTART_SAFE_STORAGE) {
      const media = mediaStore.describe();
      const statePersistent = Boolean(persistence?.durable || persistentRoot);
      const mediaPersistent = Boolean(media.persistent || persistentRoot);
      if (!(statePersistent && mediaPersistent)) return res.status(409).json({ error:"Restart-safe storage is not configured. Refusing new schedules until both state and media are persistent.", storage:{statePersistent,mediaPersistent,media:media.type} });
    }
    const { mediaRef, accountIds, caption, schedule, videoName, sourceUploadId, clientBatchId } = req.body || {};
    if (!mediaRef?.storageKey) return res.status(400).json({ error:"mediaRef.storageKey is required." });
    if (!Array.isArray(accountIds) || !accountIds.length) return res.status(400).json({ error:"Select at least one account." });
    if (accountIds.length > 15) return res.status(400).json({ error:"Maximum 15 accounts." });
    const accounts = read(accountsFile);
    const selected = accountIds.map(id=>accounts.find(a=>a.id===id)).filter(Boolean);
    if (selected.length !== accountIds.length) return res.status(400).json({ error:"One or more account IDs are invalid." });
    const jobs = read(jobsFile);
    const sid = String(sourceUploadId || "").trim();
    if (sid) {
      const already = jobs.filter(j => j.sourceUploadId === sid);
      if (already.length) return res.json({ ok:true, duplicate:true, created:0, jobs:already.map(jobPublic) });
    }
    const mode = schedule?.mode || "fixed";
    const count = selected.length;
    let times=[];
    if (mode === "fixed") {
      const fixed = new Date(schedule?.fixedAt).getTime();
      if (!Number.isFinite(fixed)) throw new Error("Invalid fixed time.");
      const stagger = Math.max(0, Number(schedule?.staggerMinutes || 0))*60_000;
      times = selected.map((_,i)=>fixed+i*stagger);
    } else {
      const start = new Date(schedule?.startAt).getTime();
      const end = new Date(schedule?.endAt).getTime();
      times = generateTimes(count,start,end,Number(schedule?.gapMinutes || 5));
    }
    const created=[];
    for (let i=0;i<selected.length;i++) {
      const a=selected[i];
      const job={
        id:newId(), accountId:a.id, accountLabel:a.label, videoName:String(videoName || mediaRef.videoName || mediaRef.storageKey), caption:String(caption||""),
        mediaUrl:mediaRef.mediaUrl || null, storageKey:mediaRef.storageKey, storageType:mediaRef.storageType || mediaStore.describe().type,
        scheduledAt:new Date(times[i]).toISOString(), status:"scheduled", createdAt:new Date().toISOString(), retryCount:0, nextAttemptAt:null, lastErrorType:null,
        sourceUploadId:sid||null, batchId:String(clientBatchId||"").trim()||null, scheduleMode:mode
      };
      jobs.push(job); created.push(jobPublic(job));
    }
    await write(jobsFile,jobs); await persistence?.flush?.();
    res.json({ ok:true, created:created.length, jobs:created });
  } catch(e) { res.status(400).json({ error:e.message }); }
});

app.post("/api/jobs", upload.single("video"), async (req, res) => {
  let stored = null;
  try {
    if (!req.file) return res.status(400).json({ error: "Video is required." });
    if (REQUIRE_RESTART_SAFE_STORAGE) {
      const media = mediaStore.describe();
      const statePersistent = Boolean(persistence?.durable || persistentRoot);
      const mediaPersistent = Boolean(media.persistent || persistentRoot);
      if (!(statePersistent && mediaPersistent)) throw new Error("Restart-safe storage is not configured. Refusing new schedules until both state and media are persistent.");
    }
    const accountIds = JSON.parse(req.body.accountIds || "[]");
    const schedule = JSON.parse(req.body.schedule || "{}");
    if (!Array.isArray(accountIds) || !accountIds.length) throw new Error("Select at least one account.");
    if (accountIds.length > 15) throw new Error("Maximum 15 accounts.");
    const accounts = read(accountsFile);
    const selected = accountIds.map(id => accounts.find(a => a.id === id)).filter(Boolean);
    if (selected.length !== accountIds.length) throw new Error("One or more account IDs are invalid.");
    stored = await mediaStore.store(req.file);
    const jobs = read(jobsFile);
    const sourceUploadId = String(req.body.sourceUploadId || "").trim();
    if (sourceUploadId) {
      const already = jobs.filter(j => j.sourceUploadId === sourceUploadId);
      if (already.length) {
        await mediaStore.remove(stored).catch(()=>{});
        stored = null;
        return res.json({ ok:true, duplicate:true, created:0, jobs:already.map(jobPublic) });
      }
    }
    const mode = schedule.mode || "fixed";
    const count = selected.length;
    let times = [];
    if (mode === "fixed") {
      const fixed = new Date(schedule.fixedAt).getTime();
      if (!Number.isFinite(fixed)) throw new Error("Invalid fixed time.");
      const stagger = Math.max(0, Number(schedule.staggerMinutes || 0)) * 60_000;
      times = selected.map((_, i) => fixed + i * stagger);
    } else {
      const start = new Date(schedule.startAt).getTime();
      const end = new Date(schedule.endAt).getTime();
      times = generateTimes(count, start, end, Number(schedule.gapMinutes || 5));
    }
    const created = [];
    for (let i = 0; i < selected.length; i++) {
      const a = selected[i];
      const job = { id:newId(), accountId:a.id, accountLabel:a.label, videoName:req.file.originalname, caption:String(req.body.caption || ""), mediaUrl:stored.mediaUrl, storageKey:stored.storageKey, storageType:stored.storageType, scheduledAt:new Date(times[i]).toISOString(), status:"scheduled", createdAt:new Date().toISOString(), retryCount:0, nextAttemptAt:null, lastErrorType:null, sourceUploadId:sourceUploadId||null, batchId:String(req.body.clientBatchId||"").trim()||null, scheduleMode:mode };
      jobs.push(job); created.push(jobPublic(job));
    }
    await write(jobsFile, jobs);
    await persistence?.flush?.();
    res.json({ ok: true, created: created.length, jobs: created });
  } catch (e) {
    if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
    if (stored) await mediaStore.remove(stored).catch(()=>{});
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/jobs/monthly", upload.single("video"), async (req, res) => {
  let stored = null;
  try {
    if (!req.file) return res.status(400).json({ error:"Video is required." });
    if (REQUIRE_RESTART_SAFE_STORAGE) {
      const media=mediaStore.describe(); const statePersistent=Boolean(persistence?.durable||persistentRoot); const mediaPersistent=Boolean(media.persistent||persistentRoot);
      if (!(statePersistent&&mediaPersistent)) throw new Error("Restart-safe storage is not configured. Refusing new schedules until both state and media are persistent.");
    }
    const accountIds=JSON.parse(req.body.accountIds||"[]");
    const schedule=JSON.parse(req.body.schedule||"{}");
    const clientBatchId=String(req.body.clientBatchId||"").trim();
    const sourceUploadId=String(req.body.sourceUploadId||"").trim();
    if(!Array.isArray(accountIds)||!accountIds.length) throw new Error("Select at least one account.");
    if(accountIds.length>15) throw new Error("Maximum 15 accounts.");
    if(!clientBatchId) throw new Error("clientBatchId is required for monthly schedules.");
    const startDate=String(schedule.startDate||""); const endDate=String(schedule.endDate||"");
    const startMs=Date.parse(startDate+"T00:00:00Z"); const endMs=Date.parse(endDate+"T00:00:00Z");
    if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<startMs) throw new Error("Invalid monthly start/end date.");
    const dayIndex=Math.max(0,Math.trunc(Number(schedule.dayIndex||0)));
    const dailyLimit=Math.max(1,Math.min(60,Math.trunc(Number(schedule.dailyLimit||50))));
    if(dayIndex>=dailyLimit) throw new Error("Monthly dayIndex exceeds the daily limit.");
    const dayCount=Math.floor((endMs-startMs)/86400000)+1;
    if(dayCount>62) throw new Error("Maximum monthly range is 62 days.");
    const accounts=read(accountsFile); const selected=accountIds.map(id=>accounts.find(a=>a.id===id)).filter(Boolean);
    if(selected.length!==accountIds.length) throw new Error("One or more account IDs are invalid.");
    const jobs=read(jobsFile);
    if(sourceUploadId){const already=jobs.filter(j=>j.sourceUploadId===sourceUploadId); if(already.length){return res.json({ok:true,duplicate:true,created:0,jobs:already.map(jobPublic)});}}
    stored=await mediaStore.store(req.file);
    const created=[];
    for(let d=0;d<dayCount;d++){
      const dayStart=startMs+d*86400000;
      for(let ai=0;ai<selected.length;ai++){
        const a=selected[ai];
        const accountOffsetMs=Math.floor((ai*86400000)/Math.max(1,selected.length));
        const slotMs=Math.floor((dayIndex*86400000)/dailyLimit);
        const jitterSpan=Math.max(60_000,Math.floor(86400000/dailyLimit*0.35));
        const deterministicSeed=crypto.createHash("sha256").update(clientBatchId+"|"+a.id+"|"+d+"|"+dayIndex).digest().readUInt32BE(0)/0xffffffff;
        const jitter=Math.floor((deterministicSeed-0.5)*jitterSpan);
        let scheduledAt=dayStart+((slotMs+accountOffsetMs+jitter)%86400000+86400000)%86400000;
        const job={id:newId(),accountId:a.id,accountLabel:a.label,videoName:req.file.originalname,caption:String(req.body.caption||""),mediaUrl:stored.mediaUrl,storageKey:stored.storageKey,storageType:stored.storageType,scheduledAt:new Date(scheduledAt).toISOString(),status:"scheduled",createdAt:new Date().toISOString(),retryCount:0,nextAttemptAt:null,lastErrorType:null,sourceUploadId:sourceUploadId||null,batchId:clientBatchId,scheduleMode:"monthly24",monthlyDay:new Date(dayStart).toISOString().slice(0,10),monthlyDayIndex:dayIndex,dailyLimit};
        jobs.push(job); created.push(jobPublic(job));
      }
    }
    await write(jobsFile,jobs); await persistence?.flush?.();
    res.json({ok:true,created:created.length,dayCount,dailyLimit,jobs:created});
  } catch(e){ if(req.file?.path){try{fs.unlinkSync(req.file.path);}catch(_){}} if(stored)await mediaStore.remove(stored).catch(()=>{}); res.status(400).json({error:e.message}); }
});

app.delete("/api/jobs/:id", async (req, res) => {
  const jobs = read(jobsFile);
  const idx = jobs.findIndex(j => j.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "Job not found." });
  const job = jobs[idx];
  if (job.status === "publishing") return res.status(409).json({ error: "This job is currently publishing." });
  jobs.splice(idx, 1);
  await write(jobsFile, jobs);
  await persistence?.flush?.();
  res.json({ ok: true });
});

app.post("/api/jobs/:id/post-now", async (req, res) => {
  const jobs = read(jobsFile);
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status === "published") return res.status(409).json({ error: "Already published." });
  if (job.status === "publishing") return res.status(409).json({ error: "Publishing already in progress." });
  job.scheduledAt = new Date().toISOString();
  if (job.status === "failed" || job.status === "retry_wait") {
    job.status = job.containerId ? "processing" : "scheduled";
    job.error = null;
    job.lastErrorType = null;
  }
  job.nextAttemptAt = null;
  await write(jobsFile, jobs);
  await persistence?.flush?.();
  res.json({ ok: true, id: job.id, status: job.status, scheduledAt: job.scheduledAt });
});

function isRateLimitError(message) {
  const m = String(message || "").toLowerCase();
  return m.includes("application request limit reached") || m.includes("too many calls") || m.includes("rate limit") || m.includes("code 4") || m.includes("code 17") || m.includes("code 32");
}

function retryDelayMs(retryCount, rateLimited) {
  if (rateLimited) return RATE_LIMIT_BACKOFF_MS;
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
  const videoUrl = typeof mediaStore?.metaUrl === "function" ? await mediaStore.metaUrl(job) : job.mediaUrl;
  const created = await graph(`${account.igUserId}/media`, { media_type: "REELS", video_url: videoUrl, caption: job.caption, share_to_feed: "true" }, token);
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

    const rebasedLate = rebaseLateBacklog(jobs, now, "automatic_wake_catchup");
    if (rebasedLate) changed = true;

    for (const job of jobs) {
      if (job.status === "retry_wait" && eligibleAt(job, now)) {
        job.status = job.containerId ? "processing" : "scheduled";
        job.nextAttemptAt = null;
        changed = true;
      }
    }

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
            job.containerId = null;
            throw new Error(`Instagram container status: ${state.status_code}`);
          } else {
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

app.listen(PORT, "0.0.0.0", () => console.log(`Insta Auto Publisher v14.8 direct-drive-bandwidth-saver backend running on port ${PORT}`));
