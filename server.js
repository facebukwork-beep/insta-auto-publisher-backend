import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 10000);
const GRAPH = process.env.GRAPH_API_VERSION || "v23.0";
const SECRET = process.env.APP_SECRET_KEY || "";
const PREPARE_AHEAD_MS = Number(process.env.PREPARE_AHEAD_MINUTES || 10) * 60_000;
const META_MIN_REQUEST_INTERVAL_MS = Math.max(5, Number(process.env.META_MIN_REQUEST_INTERVAL_SECONDS || 10)) * 1000;
const RATE_LIMIT_BACKOFF_MS = Math.max(5, Number(process.env.META_RATE_LIMIT_BACKOFF_MINUTES || 30)) * 60_000;
const MAX_AUTO_RETRIES = Math.max(1, Number(process.env.MAX_AUTO_RETRIES || 8));

if (!SECRET) {
  console.error("APP_SECRET_KEY is required.");
  process.exit(1);
}

const KEY = crypto.createHash("sha256").update(SECRET, "utf8").digest();
const dataDir = path.join(__dirname, "data");
const mediaDir = path.join(__dirname, "media");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });

const accountsFile = path.join(dataDir, "accounts.json");
const jobsFile = path.join(dataDir, "jobs.json");
if (!fs.existsSync(accountsFile)) fs.writeFileSync(accountsFile, "[]");
if (!fs.existsSync(jobsFile)) fs.writeFileSync(jobsFile, "[]");

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const write = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 2));
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

app.get("/", (req, res) => {
  res.type("html").send(`<html><head><title>Insta Auto Publisher v10</title></head><body style="font-family:Arial;background:#0b1018;color:white;padding:40px"><h1>✅ Insta Auto Publisher v10.4 Backend is Live</h1><p>Exact-time pre-processing + multi-video/multi-account scheduling enabled.</p><p>Health: <code>/api/health</code></p><p>Graph API: <b>${GRAPH}</b></p></body></html>`);
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: "10.4.0", graphApiVersion: GRAPH, publicBaseUrl: publicBaseUrl(req), prepareAheadMinutes: PREPARE_AHEAD_MS / 60_000, metaMinRequestIntervalSeconds: META_MIN_REQUEST_INTERVAL_MS / 1000, rateLimitBackoffMinutes: RATE_LIMIT_BACKOFF_MS / 60_000 });
});

app.get("/api/accounts", (req, res) => res.json(read(accountsFile).map(({ tokenEnc, ...account }) => account)));

function makeBackupBlob(item) {
  return encrypt(JSON.stringify({ v: 1, label: item.label, igUserId: item.igUserId, tokenEnc: item.tokenEnc }));
}

app.post("/api/accounts/restore", (req, res) => {
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
  if (restored) write(accountsFile, accounts);
  res.json({ ok: true, restored });
});

app.post("/api/accounts", (req, res) => {
  const { label, igUserId, accessToken } = req.body || {};
  if (!label || !igUserId || !accessToken) return res.status(400).json({ error: "label, igUserId and accessToken are required" });
  const accounts = read(accountsFile);
  const normalizedIgUserId = String(igUserId).trim();
  if (accounts.some((a) => String(a.igUserId).trim() === normalizedIgUserId)) return res.status(409).json({ error: "This Instagram account is already connected." });
  const item = { id: newId(), label: String(label).replace(/^@/, "").trim(), igUserId: normalizedIgUserId, tokenEnc: encrypt(String(accessToken).trim()), createdAt: new Date().toISOString() };
  accounts.push(item); write(accountsFile, accounts);
  res.json({ id: item.id, label: item.label, igUserId: item.igUserId, backupBlob: makeBackupBlob(item) });
});

app.delete("/api/accounts/:id", (req, res) => {
  const accounts = read(accountsFile);
  const account = accounts.find((a) => a.id === req.params.id);
  if (!account) return res.status(404).json({ error: "Account not found." });
  const jobs = read(jobsFile);
  const active = jobs.some((j) => j.accountId === account.id && ["scheduled", "processing", "ready", "publishing", "retry_wait"].includes(j.status));
  if (active) return res.status(409).json({ error: "Finish this account's active jobs before removing it." });
  write(accountsFile, accounts.filter((a) => a.id !== account.id));
  res.json({ ok: true, removedId: account.id });
});

app.get("/api/jobs", (req, res) => res.json(read(jobsFile)));

// Manually remove a queued job. We intentionally block jobs that are actively
// processing/publishing or already published so a user cannot interrupt a Meta
// API transaction halfway through.
app.delete("/api/jobs/:id", (req, res) => {
  const jobs = read(jobsFile);
  const index = jobs.findIndex((j) => j.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: "Job not found." });
  const job = jobs[index];
  if (["processing", "publishing", "published"].includes(job.status)) {
    return res.status(409).json({ error: `Cannot delete a ${job.status} job.` });
  }
  const [removed] = jobs.splice(index, 1);
  write(jobsFile, jobs);

  // Delete the local media file only if no other queued/history job references it.
  if (removed.mediaUrl && !jobs.some((j) => j.mediaUrl === removed.mediaUrl)) {
    try {
      const pathname = new URL(removed.mediaUrl).pathname;
      const name = decodeURIComponent(path.basename(pathname));
      const filePath = path.join(mediaDir, name);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
  }
  res.json({ ok: true, deleted: removed.id });
});

// Ignore the original schedule for one job and move it to the front of the
// normal smart-rate-limit queue. It still respects Meta throttling/backoff.
app.post("/api/jobs/:id/post-now", (req, res) => {
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
  write(jobsFile, jobs);
  res.json({ ok: true, id: job.id, status: job.status, scheduledAt: job.scheduledAt });
});

app.post("/api/schedule", upload.array("videos", 10), (req, res) => {
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

    const base = publicBaseUrl(req);
    const storedFiles = files.map((file) => {
      const ext = path.extname(file.originalname) || ".mp4";
      const finalName = `${file.filename}${ext}`;
      fs.renameSync(file.path, path.join(mediaDir, finalName));
      return { originalname: file.originalname, mediaUrl: `${base}/media/${encodeURIComponent(finalName)}` };
    });

    const jobs = read(jobsFile);
    const batchId = cfg.batchId || newId();
    let index = 0;
    // Every selected video is scheduled to every selected account.
    for (const file of storedFiles) {
      for (const account of selected) {
        jobs.push({
          id: newId(),
          batchId,
          accountId: account.id,
          accountLabel: account.label,
          igUserId: account.igUserId,
          fileName: file.originalname,
          mediaUrl: file.mediaUrl,
          caption: cfg.caption || "",
          scheduledAt: new Date(scheduleTimes[index++]).toISOString(),
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
          lastErrorType: null
        });
      }
    }

    write(jobsFile, jobs);
    res.json({ ok: true, created: totalJobs, videos: files.length, accounts: selected.length, firstScheduledAt: new Date(scheduleTimes[0]).toISOString(), lastScheduledAt: new Date(scheduleTimes[scheduleTimes.length - 1]).toISOString() });
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

app.post("/api/jobs/:id/retry", (req, res) => {
  const jobs = read(jobsFile);
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "failed") return res.status(409).json({ error: "Only failed jobs can be retried manually." });
  job.status = job.containerId ? "processing" : "scheduled";
  job.error = null;
  job.lastErrorType = null;
  job.nextAttemptAt = new Date(Date.now() + 15_000).toISOString();
  job.retryCount = 0;
  write(jobsFile, jobs);
  res.json({ ok: true, id: job.id, status: job.status });
});

app.post("/api/jobs/retry-failed", (req, res) => {
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
  if (count) write(jobsFile, jobs);
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

async function runScheduler() {
  if (busy) return;
  const now = Date.now();
  if (now < globalBackoffUntil) return;
  if (now - lastMetaRequestAt < META_MIN_REQUEST_INTERVAL_MS) return;
  busy = true;
  try {
    const accounts = read(accountsFile);
    const jobs = read(jobsFile);
    let changed = false;

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
          write(jobsFile, jobs);
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

    if (changed) write(jobsFile, jobs);
  } finally {
    busy = false;
  }
}

setInterval(runScheduler, 5_000);
runScheduler();

app.listen(PORT, "0.0.0.0", () => console.log(`Insta Auto Publisher v10.3 backend running on port ${PORT}`));
