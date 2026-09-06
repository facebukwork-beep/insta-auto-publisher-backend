import { neon } from "@neondatabase/serverless";

const DEFAULT_PUBLIC_BASE = "https://insta-auto-publisher-backend.facebukwork.workers.dev";
let driveCache = { token: null, exp: 0, folderId: null };
let ensured = new Map();

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/media-proxy/")) await ensureDb(env);
      return await route(request, env);
    } catch (e) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduler(env).catch(e => console.error("scheduler", e?.stack || e)));
  }
};

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,HEAD,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization,range",
    "cache-control": "no-store"
  };
}
function json(data, status = 200) { return Response.json(data, { status, headers: cors() }); }
function text(data, status = 200, type = "text/plain;charset=utf-8") { return new Response(data, { status, headers: { ...cors(), "content-type": type } }); }
function envNum(env, key, def) { const n = Number(env[key]); return Number.isFinite(n) ? n : def; }
function graphVersion(env) { return String(env.GRAPH_API_VERSION || "v23.0").trim(); }
function newId() { return crypto.randomUUID(); }
function publicBase(env) { return String(env.PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE).replace(/\/$/, ""); }
function hex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, "0")).join(""); }
function unhex(s) { if (!s || s.length % 2) throw new Error("Invalid encrypted payload"); const out = new Uint8Array(s.length / 2); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return out; }

async function secretKey(env) {
  if (!env.APP_SECRET_KEY) throw new Error("APP_SECRET_KEY is not configured in Cloudflare");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.APP_SECRET_KEY));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encrypt(env, plain) {
  const key = await secretKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const all = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, new TextEncoder().encode(String(plain))));
  const tag = all.slice(all.length - 16), data = all.slice(0, -16);
  return `${hex(iv)}.${hex(tag)}.${hex(data)}`;
}
async function decrypt(env, payload) {
  const [ivh, tagh, datah] = String(payload || "").split(".");
  if (!ivh || !tagh || datah === undefined) throw new Error("Encrypted payload is invalid");
  const key = await secretKey(env), iv = unhex(ivh), tag = unhex(tagh), data = unhex(datah), all = new Uint8Array(data.length + tag.length);
  all.set(data); all.set(tag, data.length);
  const out = await crypto.subtle.decrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, all);
  return new TextDecoder().decode(out);
}

function db(env) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not configured in Cloudflare");
  return neon(env.DATABASE_URL);
}
async function ensureDb(env) {
  const key = String(env.DATABASE_URL || "");
  if (!key) return;
  if (ensured.has(key)) return ensured.get(key);
  const p = (async () => {
    const sql = db(env);
    await sql`CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY,value JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`CREATE TABLE IF NOT EXISTS jobs_state (id TEXT PRIMARY KEY,value JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  })();
  ensured.set(key, p);
  try { await p; } catch (e) { ensured.delete(key); throw e; }
}
async function stateGet(env, key) { const r = await db(env)`SELECT value FROM app_state WHERE key=${key}`; return r[0]?.value ?? null; }
async function stateSet(env, key, value) { await db(env)`INSERT INTO app_state(key,value,updated_at) VALUES(${key},${JSON.stringify(value)}::jsonb,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`; }
async function getAccounts(env) { const v = await stateGet(env, "accounts"); return Array.isArray(v) ? v : []; }
async function saveAccounts(env, a) { await stateSet(env, "accounts", a); }
async function getJobs(env) { const r = await db(env)`SELECT value FROM jobs_state ORDER BY COALESCE((value->>'createdAt')::timestamptz,NOW()) ASC`; return r.map(x => x.value).filter(Boolean); }
async function getJob(env, id) { const r = await db(env)`SELECT value FROM jobs_state WHERE id=${id}`; return r[0]?.value || null; }
async function upsertJobs(env, jobs) { if (!jobs?.length) return; await db(env)`INSERT INTO jobs_state(id,value,updated_at) SELECT x->>'id',x,NOW() FROM jsonb_array_elements(${JSON.stringify(jobs)}::jsonb) x ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`; }
async function deleteJobRow(env, id) { await db(env)`DELETE FROM jobs_state WHERE id=${id}`; }
async function getSchedulerControl(env) { return { paused: false, pausedAt: null, resumedAt: null, updatedAt: null, ...((await stateGet(env, "scheduler_control")) || {}) }; }
async function setSchedulerControl(env, x) { x.updatedAt = new Date().toISOString(); await stateSet(env, "scheduler_control", x); }

function generateTimes(count, start, end, gapMinutes) {
  const gap = Math.max(0, Number(gapMinutes || 0)) * 60000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("Invalid random time window.");
  if (count > 1 && end - start < (count - 1) * gap) throw new Error("Time window is too short for the requested minimum gap.");
  const spare = end - start - (count - 1) * gap;
  const rs = Array.from({ length: count }, () => Math.random()).sort((a, b) => a - b);
  return rs.map((r, i) => Math.floor(start + r * spare + i * gap)).sort((a, b) => a - b);
}
function burstOffsetMs(env, index) {
  const size = Math.max(1, envNum(env, "SCHEDULER_BURST_SIZE", 5));
  const gap = Math.max(1, envNum(env, "SCHEDULER_BURST_GAP_MINUTES", 10));
  const br = Math.max(gap, envNum(env, "SCHEDULER_BURST_BREAK_MINUTES", 60));
  const group = Math.floor(index / size), within = index % size;
  return group * ((size - 1) * gap + br) * 60000 + within * gap * 60000;
}
function resetPrepared(job, env, now) {
  const ahead = envNum(env, "PREPARE_AHEAD_MINUTES", 10) * 60000, due = new Date(job.scheduledAt).getTime();
  if (!job.containerId || due - now <= ahead) return;
  job.containerId = null; job.preparedAt = null; job.readyAt = null; job.status = "scheduled"; job.nextAttemptAt = null;
}
async function rebaseLate(env, now, reason = "automatic_wake_catchup") {
  const grace = Math.max(30, envNum(env, "LATE_JOB_GRACE_SECONDS", 120)) * 1000, sql = db(env);
  const overdue = await sql`SELECT DISTINCT value->>'accountId' account_id FROM jobs_state WHERE value->>'status' IN ('scheduled','processing','ready','retry_wait') AND (value->>'scheduledAt')::timestamptz < to_timestamp(${(now - grace) / 1000})`;
  if (!overdue.length) return 0;
  const firstAt = now + Math.max(15, envNum(env, "CATCHUP_START_DELAY_SECONDS", 60)) * 1000;
  let changed = 0;
  for (const row of overdue) {
    const aid = row.account_id;
    const q = await sql`SELECT value FROM jobs_state WHERE value->>'accountId'=${aid} AND value->>'status' IN ('scheduled','processing','ready','retry_wait') ORDER BY (value->>'scheduledAt')::timestamptz ASC`;
    const jobs = q.map(x => x.value);
    jobs.forEach((j, i) => { j.scheduledAt = new Date(firstAt + burstOffsetMs(env, i)).toISOString(); j.catchupReason = reason; j.catchupRebasedAt = new Date().toISOString(); resetPrepared(j, env, now); });
    await upsertJobs(env, jobs); changed += jobs.length;
  }
  return changed;
}

async function route(request, env) {
  const url = new URL(request.url), p = url.pathname, m = request.method;
  let mm = p.match(/^\/api\/media-proxy\/([^/]+)$/);
  if (mm && (m === "GET" || m === "HEAD")) return mediaProxy(request, env, decodeURIComponent(mm[1]));
  if ((p === "/" || p === "/api/health") && m === "GET") return json({ ok: true, service: "insta-auto-publisher-cloudflare", version: "15.2.0", scheduler: "cron-every-minute", state: "postgres", media: "gdrive", directClientUpload: true, metaDelivery: "signed-cloudflare-drive-relay" });
  if (p === "/api/storage-status" && m === "GET") { let connected = false; try { connected = Boolean(await getDriveRefreshToken(env)); } catch {} return json({ ok: true, state: "postgres", media: "gdrive", mediaDelivery: "signed_cloudflare_drive_relay", directClientUpload: true, statePersistent: Boolean(env.DATABASE_URL), mediaPersistent: connected, restartSafe: Boolean(env.DATABASE_URL) && connected, safeToSchedule: Boolean(env.DATABASE_URL) && connected, exactTimingWarning: null }); }
  if (p === "/api/accounts" && m === "GET") { const a = await getAccounts(env); return json(a.map(({ tokenEnc, ...x }) => x)); }
  if (p === "/api/accounts" && m === "POST") return addAccount(request, env);
  if (p === "/api/accounts/recovery-pack" && m === "GET") return recoveryPack(env);
  if (p === "/api/accounts/restore" && m === "POST") return restoreAccounts(request, env);
  mm = p.match(/^\/api\/accounts\/([^/]+)$/); if (mm && m === "DELETE") return removeAccount(env, decodeURIComponent(mm[1]));
  if (p === "/api/jobs" && m === "GET") return json(await getJobs(env));
  if (p === "/api/dashboard-state" && m === "GET") return dashboardState(env);
  if (p === "/api/scheduler/status" && m === "GET") return schedulerStatus(env);
  if (p === "/api/scheduler/pause" && m === "POST") return pauseScheduler(env);
  if (p === "/api/scheduler/resume" && m === "POST") return resumeScheduler(env);
  if (p === "/api/jobs/retry-failed" && m === "POST") return retryFailed(env);
  mm = p.match(/^\/api\/jobs\/([^/]+)\/(post-now|retry)$/); if (mm && m === "POST") return mm[2] === "post-now" ? postNow(env, decodeURIComponent(mm[1])) : retryJob(env, decodeURIComponent(mm[1]));
  mm = p.match(/^\/api\/jobs\/([^/]+)$/); if (mm && m === "DELETE") return deleteJob(env, decodeURIComponent(mm[1]));
  if ((p === "/api/direct-upload/init" || p === "/api/media/presign") && m === "POST") return directUploadInit(request, env);
  if (p === "/api/direct-upload/delete" && m === "POST") return directUploadDelete(request, env);
  if (p === "/api/schedule-direct" && m === "POST") return scheduleDirect(request, env);
  if (p === "/api/published-stats" && m === "GET") return publishedStats(url, env);
  if (p === "/api/account-analytics" && m === "GET") return accountAnalytics(url, env);
  if ((p === "/api/google-drive/status" || p === "/api/google-drive/connect-info") && m === "GET") return driveStatus(request, env);
  if (p === "/api/google-drive/connect" && m === "GET") return driveConnect(request, env);
  if (p === "/api/google-drive/oauth/callback" && m === "GET") return driveCallback(request, env);
  if (p === "/api/drive-test" && m === "GET") return driveTest(env);
  return json({ error: "Not found" }, 404);
}

async function recoveryPack(env) {
  const a = await getAccounts(env), backups = [];
  for (const item of a) backups.push({ igUserId: String(item.igUserId), label: item.label, backupBlob: await encrypt(env, JSON.stringify({ v: 2, label: item.label, igUserId: item.igUserId, tokenEnc: item.tokenEnc })) });
  return json({ ok: true, count: a.length, backups });
}
async function restoreAccounts(request, env) {
  const b = await request.json().catch(() => ({})), blobs = Array.isArray(b.backups) ? b.backups : [], accounts = await getAccounts(env); let restored = 0;
  for (const blob of blobs.slice(0, 30)) { try { const data = JSON.parse(await decrypt(env, String(blob))); if (!data?.igUserId || !data?.label || !data?.tokenEnc) continue; const ig = String(data.igUserId).trim(); if (accounts.some(a => String(a.igUserId).trim() === ig)) continue; await decrypt(env, data.tokenEnc); accounts.push({ id: newId(), label: String(data.label).replace(/^@/, "").trim(), igUserId: ig, tokenEnc: data.tokenEnc, createdAt: new Date().toISOString(), restoredAt: new Date().toISOString() }); restored++; } catch {} }
  if (restored) await saveAccounts(env, accounts); return json({ ok: true, restored });
}
async function addAccount(request, env) {
  const b = await request.json().catch(() => ({}));
  if (!b.label || !b.igUserId || !b.accessToken) return json({ error: "label, igUserId and accessToken are required" }, 400);
  const a = await getAccounts(env), ig = String(b.igUserId).trim();
  if (a.some(x => String(x.igUserId).trim() === ig)) return json({ error: "This Instagram account is already connected." }, 409);
  if (a.length >= 15) return json({ error: "Maximum 15 accounts are supported." }, 400);
  const item = { id: newId(), label: String(b.label).replace(/^@/, "").trim(), igUserId: ig, tokenEnc: await encrypt(env, String(b.accessToken).trim()), createdAt: new Date().toISOString() };
  a.push(item); await saveAccounts(env, a);
  const backupBlob = await encrypt(env, JSON.stringify({ v: 2, label: item.label, igUserId: item.igUserId, tokenEnc: item.tokenEnc }));
  return json({ id: item.id, label: item.label, igUserId: item.igUserId, backupBlob });
}
async function removeAccount(env, id) {
  const a = await getAccounts(env), item = a.find(x => x.id === id); if (!item) return json({ error: "Account not found." }, 404);
  const q = await db(env)`SELECT 1 FROM jobs_state WHERE value->>'accountId'=${id} AND value->>'status' IN ('scheduled','processing','ready','publishing','retry_wait') LIMIT 1`;
  if (q.length) return json({ error: "Finish this account's active jobs before removing it." }, 409);
  await saveAccounts(env, a.filter(x => x.id !== id)); return json({ ok: true, removedId: id });
}

async function dashboardState(env) {
  const sql = db(env);
  const cr = await sql`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE value->>'status' IN ('scheduled','processing','ready','publishing','retry_wait'))::int active,COUNT(*) FILTER(WHERE value->>'status'='published')::int published,COUNT(*) FILTER(WHERE value->>'status'='failed')::int failed FROM jobs_state`;
  const q = await sql`SELECT value FROM jobs_state WHERE value->>'status'<>'published' ORDER BY (value->>'scheduledAt')::timestamptz ASC LIMIT 600`;
  const pub = await sql`SELECT value FROM jobs_state WHERE value->>'status'='published' ORDER BY COALESCE((value->>'publishedAt')::timestamptz,(value->>'scheduledAt')::timestamptz) DESC LIMIT 150`;
  const c = cr[0] || { total: 0, active: 0, published: 0, failed: 0 };
  return json({ ok: true, counts: c, jobs: [...q.map(x => x.value), ...pub.map(x => x.value)], queueReturned: q.length, publishedReturned: pub.length, truncated: c.total > q.length + pub.length });
}
async function schedulerStatus(env) {
  const ctl = await getSchedulerControl(env), now = Date.now(), grace = Math.max(30, envNum(env, "LATE_JOB_GRACE_SECONDS", 120)) * 1000;
  const r = await db(env)`SELECT COUNT(*) FILTER(WHERE value->>'status' IN ('scheduled','processing','ready','retry_wait'))::int active,COUNT(*) FILTER(WHERE value->>'status' IN ('scheduled','processing','ready','retry_wait') AND (value->>'scheduledAt')::timestamptz<to_timestamp(${(now - grace) / 1000}))::int overdue FROM jobs_state`;
  return json({ ok: true, paused: Boolean(ctl.paused), pausedAt: ctl.pausedAt || null, resumedAt: ctl.resumedAt || null, activeJobs: r[0]?.active || 0, overdueJobs: r[0]?.overdue || 0, catchupProtection: true, pattern: { burstSize: envNum(env, "SCHEDULER_BURST_SIZE", 5), gapMinutes: envNum(env, "SCHEDULER_BURST_GAP_MINUTES", 10), breakMinutes: envNum(env, "SCHEDULER_BURST_BREAK_MINUTES", 60) } });
}
async function pauseScheduler(env) { const ctl = await getSchedulerControl(env); if (!ctl.paused) { ctl.paused = true; ctl.pausedAt = new Date().toISOString(); await setSchedulerControl(env, ctl); } return json({ ok: true, paused: true, pausedAt: ctl.pausedAt }); }
async function resumeScheduler(env) {
  const ctl = await getSchedulerControl(env), now = Date.now(); let shifted = 0;
  if (ctl.paused && ctl.pausedAt) { const d = Math.max(0, now - new Date(ctl.pausedAt).getTime()); if (d > 0) { const q = await db(env)`SELECT value FROM jobs_state WHERE value->>'status' IN ('scheduled','processing','ready','retry_wait')`, jobs = q.map(x => x.value); for (const j of jobs) { const t = new Date(j.scheduledAt).getTime(); if (Number.isFinite(t)) { j.scheduledAt = new Date(t + d).toISOString(); if (j.nextAttemptAt) { const n = new Date(j.nextAttemptAt).getTime(); if (Number.isFinite(n)) j.nextAttemptAt = new Date(n + d).toISOString(); } shifted++; } } await upsertJobs(env, jobs); } }
  const rebased = await rebaseLate(env, now, "manual_resume_catchup"); ctl.paused = false; ctl.pausedAt = null; ctl.resumedAt = new Date().toISOString(); await setSchedulerControl(env, ctl);
  return json({ ok: true, paused: false, shiftedJobs: shifted, rebasedJobs: rebased, resumedAt: ctl.resumedAt });
}
async function postNow(env, id) { const j = await getJob(env, id); if (!j) return json({ error: "Job not found." }, 404); if (["processing", "publishing", "published"].includes(j.status)) return json({ error: `Cannot Post Now while job is ${j.status}.` }, 409); j.scheduledAt = new Date().toISOString(); j.nextAttemptAt = null; j.error = null; j.lastErrorType = null; j.status = j.status === "ready" ? "ready" : (j.containerId ? "processing" : "scheduled"); await upsertJobs(env, [j]); return json({ ok: true, id: j.id, status: j.status, scheduledAt: j.scheduledAt }); }
async function retryJob(env, id) { const j = await getJob(env, id); if (!j) return json({ error: "Job not found." }, 404); if (j.status !== "failed") return json({ error: "Only failed jobs can be retried manually." }, 409); j.status = j.containerId ? "processing" : "scheduled"; j.error = null; j.lastErrorType = null; j.nextAttemptAt = new Date(Date.now() + 15000).toISOString(); j.retryCount = 0; await upsertJobs(env, [j]); return json({ ok: true, id: j.id, status: j.status }); }
async function retryFailed(env) { const q = await db(env)`SELECT value FROM jobs_state WHERE value->>'status'='failed'`, jobs = q.map(x => x.value); jobs.forEach((j, i) => { j.status = j.containerId ? "processing" : "scheduled"; j.error = null; j.lastErrorType = null; j.nextAttemptAt = new Date(Date.now() + 15000 + i * 1000).toISOString(); j.retryCount = 0; }); await upsertJobs(env, jobs); return json({ ok: true, retried: jobs.length }); }
async function deleteJob(env, id) { const j = await getJob(env, id); if (!j) return json({ error: "Job not found." }, 404); if (["processing", "publishing", "published"].includes(j.status)) return json({ error: `Cannot delete a ${j.status} job.` }, 409); await deleteJobRow(env, id); return json({ ok: true, deleted: id }); }

async function getDriveRefreshToken(env) { if (env.GDRIVE_REFRESH_TOKEN) return String(env.GDRIVE_REFRESH_TOKEN).trim(); const s = await stateGet(env, "gdrive_oauth"); if (s?.tokenEnc) return decrypt(env, s.tokenEnc); return ""; }
async function driveAccessToken(env, force = false) {
  if (!force && driveCache.token && Date.now() < driveCache.exp - 60000) return driveCache.token;
  const refresh = await getDriveRefreshToken(env); if (!refresh) throw new Error("Google Drive is not connected.");
  if (!env.GDRIVE_CLIENT_ID || !env.GDRIVE_CLIENT_SECRET) throw new Error("GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET are not configured in Cloudflare");
  const body = new URLSearchParams({ client_id: env.GDRIVE_CLIENT_ID, client_secret: env.GDRIVE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const x = await r.json().catch(() => ({})); if (!r.ok || !x.access_token) throw new Error(`Google OAuth refresh failed (${r.status}): ${x.error_description || x.error || "Bad Request"}`);
  driveCache.token = x.access_token; driveCache.exp = Date.now() + Number(x.expires_in || 3600) * 1000; return driveCache.token;
}
async function driveFetch(env, url, opts = {}, retry = true) {
  let tok = await driveAccessToken(env), r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` } });
  if (r.status === 401 && retry) { driveCache.token = null; tok = await driveAccessToken(env, true); r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}` } }); }
  return r;
}
async function driveFolder(env) {
  if (driveCache.folderId) return driveCache.folderId;
  const configured = String(env.GDRIVE_FOLDER_ID || "").trim();
  if (configured) { const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(configured)}?fields=id,mimeType,trashed&supportsAllDrives=true`); if (r.ok) { const j = await r.json(); if (j.id && !j.trashed && j.mimeType === "application/vnd.google-apps.folder") return driveCache.folderId = configured; } }
  const name = String(env.GDRIVE_FOLDER_NAME || "Insta Auto Publisher Media").replace(/'/g, "\\'"), q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  let r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=10`);
  if (r.ok) { const j = await r.json(); if (j.files?.length) return driveCache.folderId = j.files[0].id; }
  r = await driveFetch(env, "https://www.googleapis.com/drive/v3/files?fields=id", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: String(env.GDRIVE_FOLDER_NAME || "Insta Auto Publisher Media"), mimeType: "application/vnd.google-apps.folder" }) });
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.id) throw new Error(`Google Drive folder creation failed: ${j.error?.message || r.status}`); return driveCache.folderId = j.id;
}
async function hmacHex(secret, msg) { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)))); }
async function makeMediaProxyUrl(env, fileId) { const exp = Math.floor(Date.now() / 1000) + Math.max(3600, envNum(env, "MEDIA_PROXY_TTL_SECONDS", 21600)); const sig = await hmacHex(env.APP_SECRET_KEY, `${fileId}.${exp}`); return `${publicBase(env)}/api/media-proxy/${encodeURIComponent(fileId)}?exp=${exp}&sig=${sig}`; }
async function mediaProxy(request, env, fileId) {
  const u = new URL(request.url), exp = Number(u.searchParams.get("exp") || 0), sig = String(u.searchParams.get("sig") || "");
  if (!fileId || !Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000) - 60) return text("Expired media URL", 403);
  const expected = await hmacHex(env.APP_SECRET_KEY, `${fileId}.${exp}`); if (!sig || sig !== expected) return text("Invalid media signature", 403);
  const headers = {}; const range = request.headers.get("range"); if (range) headers.Range = range;
  const upstream = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { method: request.method === "HEAD" ? "HEAD" : "GET", headers });
  if (!upstream.ok && upstream.status !== 206) return text(`Media fetch failed (${upstream.status})`, upstream.status === 404 ? 404 : 502);
  const out = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) { const v = upstream.headers.get(h); if (v) out.set(h, v); }
  out.set("cache-control", "private, no-store"); out.set("access-control-allow-origin", "*"); out.set("accept-ranges", out.get("accept-ranges") || "bytes");
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
}
async function directUploadInit(request, env) {
  const b = await request.json().catch(() => ({}));
  const name = String(b.name || b.videoName || "video.mp4").slice(0, 300), type = String(b.type || b.mimeType || "video/mp4").slice(0, 120), size = Number(b.size || 0);
  if (!size || size <= 0 || size > 1024 * 1024 * 1024) return json({ error: "Invalid direct-upload file metadata." }, 400);
  const tok = await driveAccessToken(env), folder = await driveFolder(env), safe = `${Date.now()}-${crypto.randomUUID()}-${name.replace(/[\\/]/g, "_")}`;
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,mimeType,parents", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": type, "x-upload-content-length": String(size) }, body: JSON.stringify({ name: safe, parents: [folder] }) });
  if (!r.ok) { const x = await r.json().catch(() => ({})); return json({ error: `Google Drive direct upload init failed: ${x.error?.message || r.status}` }, 502); }
  const uploadUrl = r.headers.get("location"); if (!uploadUrl) return json({ error: "Google Drive resumable upload URL was not returned." }, 502);
  return json({ ok: true, uploadUrl, folderId: folder, name, videoName: name, mimeType: type, type, size });
}
async function directUploadDelete(request, env) { const b = await request.json().catch(() => ({})), id = String(b.fileId || "").trim(); if (!id) return json({ error: "Google Drive file id is required." }, 400); const r = await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: "DELETE" }); if (!r.ok && r.status !== 404) return json({ error: `Google Drive delete failed: HTTP ${r.status}` }, 400); return json({ ok: true, deleted: true, fileId: id }); }

async function scheduleDirect(request, env) {
  const b = await request.json().catch(() => ({})), cfg = b.config || {}, files = Array.isArray(b.files) ? b.files : [];
  if (!files.length || files.length > 10) return json({ error: "At least one and at most 10 uploaded videos are required." }, 400);
  const accounts = await getAccounts(env), selected = (cfg.accountIds || []).map(id => accounts.find(a => a.id === id)).filter(Boolean);
  if (!selected.length || selected.length > 15) return json({ error: "No valid accounts selected." }, 400);
  const total = files.length * selected.length; if (total > 150) return json({ error: "Maximum 150 generated posts per scheduling chunk." }, 400);
  const now = Date.now(); let times = [];
  if (cfg.mode === "explicit") { if (!Array.isArray(cfg.explicitTimes) || cfg.explicitTimes.length !== total) return json({ error: "Explicit schedule count does not match generated jobs." }, 400); times = cfg.explicitTimes.map(v => { const t = new Date(v).getTime(); if (!Number.isFinite(t)) throw new Error("Invalid explicit schedule time."); return t; }); }
  else if (cfg.mode === "random") times = generateTimes(total, Math.max(new Date(cfg.startAt).getTime(), now), new Date(cfg.endAt).getTime(), Number(cfg.minGapMinutes || 0));
  else { let f = new Date(cfg.fixedAt).getTime(); if (!Number.isFinite(f)) return json({ error: "Invalid fixed time." }, 400); if (f < now - 90000) return json({ error: "Fixed time is too far in the past." }, 400); if (f <= now + 5000) f = now; const gap = Math.max(0, Number(cfg.minGapMinutes || 0)) * 60000; times = Array.from({ length: total }, (_, i) => f + i * gap); }
  const iso = times.map(t => new Date(t).toISOString()), batchId = cfg.batchId || newId();
  if (cfg.batchId) { const ex = await db(env)`SELECT value FROM jobs_state WHERE value->>'batchId'=${String(cfg.batchId)}`; if (ex.length) return json({ ok: true, created: 0, deduped: ex.length, videos: files.length, accounts: selected.length, firstScheduledAt: iso[0], lastScheduledAt: iso.at(-1), directUpload: true }); }
  let idx = 0, fi = 0; const newJobs = [];
  for (const f of files) { const fileId = String(f.fileId || f.id || "").trim(), name = String(f.name || f.videoName || "video.mp4").slice(0, 300); if (!fileId) return json({ error: `Google Drive file id missing for ${name}.` }, 400); const cap = (Array.isArray(cfg.captions) && cfg.captions[fi] !== undefined ? String(cfg.captions[fi]) : String(cfg.caption || "")).slice(0, 2200); for (const a of selected) newJobs.push({ id: newId(), batchId, accountId: a.id, accountLabel: a.label, igUserId: a.igUserId, fileName: name, mediaUrl: `gdrive-direct://${fileId}`, storageKey: fileId, mediaDelivery: "signed_cloudflare_drive_relay", caption: cap, scheduledAt: iso[idx++], status: "scheduled", createdAt: new Date().toISOString(), error: null, containerId: null, preparedAt: null, publishedMediaId: null, permalink: null, retryCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorType: null, scheduleKind: cfg.scheduleKind || null, planId: cfg.planId || null, monthlyPlan: cfg.monthlyPlan || null }); fi++; }
  await upsertJobs(env, newJobs); return json({ ok: true, created: newJobs.length, videos: files.length, accounts: selected.length, firstScheduledAt: iso[0], lastScheduledAt: iso.at(-1), directUpload: true, mediaDelivery: "signed_cloudflare_drive_relay" });
}

function clientDayWindow(off = 0, now = Date.now()) { const o = Math.max(-840, Math.min(840, Number(off || 0))), s = new Date(now + o * 60000), start = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - o * 60000; return { start, end: start + 86400000, offset: o }; }
async function publishedStats(url, env) { const accounts = await getAccounts(env), { start, end, offset } = clientDayWindow(url.searchParams.get("tzOffsetMinutes")), rows = []; for (const a of accounts) { const r = await db(env)`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE COALESCE((value->>'publishedAt')::timestamptz,(value->>'scheduledAt')::timestamptz)>=to_timestamp(${start / 1000}) AND COALESCE((value->>'publishedAt')::timestamptz,(value->>'scheduledAt')::timestamptz)<to_timestamp(${end / 1000}))::int today,MIN((value->>'publishedAt')::timestamptz) first_at,MAX((value->>'publishedAt')::timestamptz) last_at FROM jobs_state WHERE value->>'accountId'=${a.id} AND value->>'status'='published'`; rows.push({ accountId: a.id, igUserId: a.igUserId, label: a.label, today: r[0]?.today || 0, total: r[0]?.total || 0, firstPublishedAt: r[0]?.first_at || null, lastPublishedAt: r[0]?.last_at || null }); } return json({ ok: true, tzOffsetMinutes: offset, accounts: rows, todayTotal: rows.reduce((s, r) => s + r.today, 0), totalPublished: rows.reduce((s, r) => s + r.total, 0) }); }
async function graph(env, path, params, token, method = "POST") { const u = new URL(`https://graph.instagram.com/${graphVersion(env)}/${path}`); for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v)); u.searchParams.set("access_token", token); const r = await fetch(u, { method }), x = await r.json().catch(() => ({})); if (!r.ok || x.error) throw new Error(x.error?.message || `Meta API HTTP ${r.status}`); return x; }
async function accountAnalytics(url, env) { const accountId = String(url.searchParams.get("accountId") || ""), a = (await getAccounts(env)).find(x => x.id === accountId); if (!a) return json({ error: "Account not found." }, 404); const token = await decrypt(env, a.tokenEnc), profile = await graph(env, a.igUserId, { fields: "username,followers_count,media_count" }, token, "GET"), currentFollowers = Number(profile.followers_count), currentMediaCount = Number(profile.media_count), w = clientDayWindow(Number(url.searchParams.get("tzOffsetMinutes") || 330)), jr = await db(env)`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE (value->>'publishedAt')::timestamptz>=to_timestamp(${w.start / 1000}) AND (value->>'publishedAt')::timestamptz<to_timestamp(${w.end / 1000}))::int today,MIN((value->>'publishedAt')::timestamptz) first_at FROM jobs_state WHERE value->>'accountId'=${a.id} AND value->>'status'='published'`; let baselines = (await stateGet(env, "analytics_baselines")) || {}, base = baselines[a.id]; if (!base?.followers || Number(base.followers) <= 0) { base = { followers: currentFollowers, baselineAt: new Date().toISOString(), source: "cloudflare_tracking_snapshot", label: a.label }; baselines[a.id] = base; await stateSet(env, "analytics_baselines", baselines); } let reachToday = null, profileViewsToday = null, insightsError = null; const since = Math.floor(w.start / 1000), until = Math.floor(Date.now() / 1000); for (const metric of ["reach", "profile_views"]) { try { const x = await graph(env, `${a.igUserId}/insights`, { metric, period: "day", since, until }, token, "GET"), vals = x?.data?.[0]?.values || [], sum = vals.map(v => Number(v.value)).filter(Number.isFinite).reduce((s, n) => s + n, 0); if (metric === "reach") reachToday = vals.length ? sum : null; else profileViewsToday = vals.length ? sum : null; } catch (e) { insightsError = insightsError || e.message; } } return json({ ok: true, accountId: a.id, label: a.label, firstPublishedAt: jr[0]?.first_at || null, todayPublished: jr[0]?.today || 0, totalPublished: jr[0]?.total || 0, currentFollowers: Number.isFinite(currentFollowers) ? currentFollowers : null, baselineFollowers: Number(base.followers) || null, baselineAt: base.baselineAt || null, baselineSource: base.source || null, followersGain: Number.isFinite(currentFollowers) ? currentFollowers - Number(base.followers) : null, currentMediaCount: Number.isFinite(currentMediaCount) ? currentMediaCount : null, reachToday, profileViewsToday, insightsPermissionNeeded: Boolean(insightsError && /permission|insufficient|unsupported|access/i.test(insightsError)), insightsError, note: "Follower gain is measured from the stored baseline snapshot." }); }

async function driveStatus(request, env) { let connected = false; try { connected = Boolean(await getDriveRefreshToken(env)); } catch {} const base = new URL(request.url).origin, redirectUri = `${base}/api/google-drive/oauth/callback`; return json({ ok: true, configured: Boolean(env.GDRIVE_CLIENT_ID && env.GDRIVE_CLIENT_SECRET), connected, durableToken: connected, redirectUri, clientIdHint: env.GDRIVE_CLIENT_ID ? `${String(env.GDRIVE_CLIENT_ID).slice(0, 8)}…${String(env.GDRIVE_CLIENT_ID).slice(-12)}` : null, connectUrl: `${base}/api/google-drive/connect` }); }
async function driveConnect(request, env) { if (!env.GDRIVE_CLIENT_ID || !env.GDRIVE_CLIENT_SECRET) return text("Configure GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET first.", 409); const base = new URL(request.url).origin, ts = Date.now().toString(36), nonce = crypto.randomUUID(), payload = `${ts}.${nonce}`, sig = await hmacHex(env.APP_SECRET_KEY, payload), state = `${payload}.${sig}`, u = new URL("https://accounts.google.com/o/oauth2/v2/auth"); for (const [k, v] of Object.entries({ client_id: env.GDRIVE_CLIENT_ID, redirect_uri: `${base}/api/google-drive/oauth/callback`, response_type: "code", scope: "https://www.googleapis.com/auth/drive.file", access_type: "offline", prompt: "consent", include_granted_scopes: "true", state })) u.searchParams.set(k, v); return Response.redirect(u.toString(), 302); }
async function driveCallback(request, env) { const u = new URL(request.url), state = String(u.searchParams.get("state") || ""), code = u.searchParams.get("code"), parts = state.split("."); if (parts.length !== 3 || !code) return text("Invalid OAuth callback.", 400); const payload = `${parts[0]}.${parts[1]}`, sig = await hmacHex(env.APP_SECRET_KEY, payload); if (sig !== parts[2]) return text("Invalid OAuth state.", 400); const body = new URLSearchParams({ client_id: env.GDRIVE_CLIENT_ID, client_secret: env.GDRIVE_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: `${u.origin}/api/google-drive/oauth/callback` }), r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }), x = await r.json().catch(() => ({})); if (!r.ok || !x.refresh_token) return text(`Google OAuth token exchange failed: ${x.error_description || x.error || r.status}`, 400); await stateSet(env, "gdrive_oauth", { tokenEnc: await encrypt(env, x.refresh_token), updatedAt: new Date().toISOString() }); driveCache.token = null; return text('<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:Arial;background:#08101d;color:white;padding:30px"><h1>✅ Google Drive connected</h1><p><a style="color:#8ab4ff" href="/api/drive-test">Run Drive test</a></p></body>', 200, "text/html;charset=utf-8"); }
async function driveTest(env) { try { const tok = await driveAccessToken(env, true), folder = await driveFolder(env), boundary = `iap-${crypto.randomUUID()}`, name = `.iap-test-${Date.now()}.txt`, meta = JSON.stringify({ name, parents: [folder] }), content = `test ${new Date().toISOString()}`, body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`, r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { Authorization: `Bearer ${tok}`, "content-type": `multipart/related; boundary=${boundary}` }, body }), x = await r.json().catch(() => ({})); if (!r.ok || !x.id) throw new Error(x.error?.message || `HTTP ${r.status}`); await driveFetch(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(x.id)}`, { method: "DELETE" }); return json({ ok: true, folderId: folder, uploadedAndDeleted: true }); } catch (e) { return json({ ok: false, error: e.message }, 502); } }

function isRateLimit(msg) { const m = String(msg || "").toLowerCase(); return m.includes("request limit") || m.includes("too many calls") || m.includes("rate limit") || m.includes("code 4") || m.includes("code 17") || m.includes("code 32"); }
function markRetry(env, j, e) { j.retryCount = Number(j.retryCount || 0) + 1; j.error = e.message; j.lastErrorType = isRateLimit(e.message) ? "rate_limit" : "transient"; const max = Math.max(1, envNum(env, "MAX_AUTO_RETRIES", 8)); if (j.retryCount > max) { j.status = "failed"; j.nextAttemptAt = null; return; } const delay = isRateLimit(e.message) ? Math.max(5, envNum(env, "META_RATE_LIMIT_BACKOFF_MINUTES", 30)) * 60000 : Math.min(3600000, 120000 * Math.max(1, 2 ** Math.min(j.retryCount - 1, 5))); j.status = "retry_wait"; j.nextAttemptAt = new Date(Date.now() + delay).toISOString(); }

async function runScheduler(env) {
  await ensureDb(env);
  const ctl = await getSchedulerControl(env); if (ctl.paused) return;
  const now = Date.now(); await rebaseLate(env, now, "automatic_wake_catchup");
  const sql = db(env), retry = await sql`SELECT value FROM jobs_state WHERE value->>'status'='retry_wait' AND (value->>'nextAttemptAt')::timestamptz<=NOW() ORDER BY (value->>'nextAttemptAt')::timestamptz ASC LIMIT 1`;
  if (retry.length) { const j = retry[0].value; j.status = j.containerId ? "processing" : "scheduled"; j.nextAttemptAt = null; await upsertJobs(env, [j]); }
  const q = await sql`SELECT value FROM jobs_state WHERE value->>'status' IN ('scheduled','processing','ready') ORDER BY (value->>'scheduledAt')::timestamptz ASC LIMIT 100`, accounts = await getAccounts(env), ahead = Math.max(1, envNum(env, "PREPARE_AHEAD_MINUTES", 10)) * 60000;
  let job = null, action = null;
  for (const row of q) { const j = row.value, due = new Date(j.scheduledAt).getTime(); if (j.nextAttemptAt && new Date(j.nextAttemptAt).getTime() > now) continue; if (j.status === "scheduled" && due - now <= ahead) { job = j; action = "create"; break; } if (j.status === "processing" && j.containerId) { job = j; action = "check"; break; } if (j.status === "ready" && due <= now) { job = j; action = "publish"; break; } }
  if (!job) return;
  const a = accounts.find(x => x.id === job.accountId); if (!a) { job.status = "failed"; job.error = "Connected account not found."; await upsertJobs(env, [job]); return; }
  const token = await decrypt(env, a.tokenEnc);
  try {
    job.lastAttemptAt = new Date().toISOString();
    if (action === "create") {
      const fileId = job.storageKey; if (!fileId) throw new Error("Google Drive file id missing.");
      const videoUrl = await makeMediaProxyUrl(env, fileId);
      const c = await graph(env, `${a.igUserId}/media`, { media_type: "REELS", video_url: videoUrl, caption: job.caption || "", share_to_feed: "true" }, token, "POST");
      job.containerId = c.id; job.status = "processing"; job.preparedAt = new Date().toISOString(); job.error = null; job.lastErrorType = null; job.mediaDelivery = "signed_cloudflare_drive_relay";
    } else if (action === "check") {
      const st = await graph(env, job.containerId, { fields: "status_code,status" }, token, "GET");
      job.lastContainerStatus = st.status_code || null; job.lastContainerStatusText = st.status || null;
      if (st.status_code === "FINISHED") {
        job.status = "ready"; job.readyAt = new Date().toISOString(); job.error = null; job.lastErrorType = null;
        if (new Date(job.scheduledAt).getTime() <= Date.now()) {
          const pub = await graph(env, `${a.igUserId}/media_publish`, { creation_id: job.containerId }, token, "POST");
          job.publishedMediaId = pub.id; job.status = "published"; job.publishedAt = new Date().toISOString(); job.nextAttemptAt = null;
          try { const pm = await graph(env, pub.id, { fields: "permalink" }, token, "GET"); job.permalink = pm.permalink || null; } catch {}
        }
      } else if (["ERROR", "EXPIRED"].includes(st.status_code)) {
        const detail = String(st.status || "").trim(); job.containerId = null; job.preparedAt = null; job.readyAt = null;
        throw new Error(`Instagram container status: ${st.status_code}${detail ? ` - ${detail}` : ""}`);
      } else job.nextAttemptAt = new Date(Date.now() + 60000).toISOString();
    } else if (action === "publish") {
      const pub = await graph(env, `${a.igUserId}/media_publish`, { creation_id: job.containerId }, token, "POST");
      job.publishedMediaId = pub.id; job.status = "published"; job.publishedAt = new Date().toISOString(); job.nextAttemptAt = null;
      try { const pm = await graph(env, pub.id, { fields: "permalink" }, token, "GET"); job.permalink = pm.permalink || null; } catch {}
    }
  } catch (e) { markRetry(env, job, e); }
  await upsertJobs(env, [job]);
}
