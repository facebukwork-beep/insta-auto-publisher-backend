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

if (!SECRET) {
  console.error("APP_SECRET_KEY is required.");
  process.exit(1);
}

// Accept any strong secret and derive a 32-byte AES key.
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
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

const newId = () => crypto.randomUUID();

function parseLocal(date, time) {
  return new Date(`${date}T${time}:00`).getTime();
}

function generateTimes(count, start, end, gapMinutes) {
  const gap = Math.max(0, Number(gapMinutes || 0)) * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Invalid random time window.");
  }
  if (count > 1 && end - start < (count - 1) * gap) {
    throw new Error("Time window is too short for the requested minimum gap.");
  }

  const spare = (end - start) - (count - 1) * gap;
  const randoms = Array.from({ length: count }, () => Math.random()).sort((a, b) => a - b);
  return randoms.map((r, i) => Math.floor(start + r * spare + i * gap)).sort((a, b) => a - b);
}

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/media", express.static(mediaDir));

const upload = multer({
  dest: mediaDir,
  limits: { fileSize: 1024 * 1024 * 1024 }
});

function publicBaseUrl(req) {
  const explicit = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (explicit) return explicit;

  const renderUrl = (process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  if (renderUrl) return renderUrl;

  return `${req.protocol}://${req.get("host")}`;
}

app.get("/", (req, res) => {
  res.type("html").send(`
    <html>
      <head><title>Insta Auto Publisher</title></head>
      <body style="font-family:Arial;background:#0b1018;color:white;padding:40px">
        <h1>✅ Insta Auto Publisher Backend is Live</h1>
        <p>Health endpoint: <code>/api/health</code></p>
        <p>Graph API version: <b>${GRAPH}</b></p>
      </body>
    </html>
  `);
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    graphApiVersion: GRAPH,
    publicBaseUrl: publicBaseUrl(req)
  });
});

app.get("/api/accounts", (req, res) => {
  res.json(read(accountsFile).map(({ tokenEnc, ...account }) => account));
});

app.post("/api/accounts", (req, res) => {
  const { label, igUserId, accessToken } = req.body || {};
  if (!label || !igUserId || !accessToken) {
    return res.status(400).json({
      error: "label, igUserId and accessToken are required"
    });
  }

  const accounts = read(accountsFile);
  const item = {
    id: newId(),
    label,
    igUserId: String(igUserId),
    tokenEnc: encrypt(accessToken),
    createdAt: new Date().toISOString()
  };

  accounts.push(item);
  write(accountsFile, accounts);

  res.json({
    id: item.id,
    label: item.label,
    igUserId: item.igUserId
  });
});

app.get("/api/jobs", (req, res) => {
  res.json(read(jobsFile));
});

app.post("/api/schedule", upload.single("video"), (req, res) => {
  try {
    if (!req.file) throw new Error("Video is required.");

    const cfg = JSON.parse(req.body.config || "{}");
    const accounts = read(accountsFile);

    const selected = (cfg.accountIds || [])
      .map((accountId) => accounts.find((a) => a.id === accountId))
      .filter(Boolean);

    if (!selected.length) throw new Error("No valid accounts selected.");
    if (selected.length > 15) throw new Error("Maximum 15 accounts per batch.");

    let scheduleTimes = [];

    if (cfg.mode === "random") {
      let start = parseLocal(cfg.date, cfg.from);
      const end = parseLocal(cfg.date, cfg.to);

      start = Math.max(start, Date.now() + 60_000);
      scheduleTimes = generateTimes(
        selected.length,
        start,
        end,
        Number(cfg.minGapMinutes || 0)
      );
    } else {
      const fixed = new Date(cfg.fixedAt).getTime();
      if (!Number.isFinite(fixed) || fixed <= Date.now()) {
        throw new Error("Fixed time must be in the future.");
      }
      scheduleTimes = selected.map(() => fixed);
    }

    const ext = path.extname(req.file.originalname) || ".mp4";
    const finalName = `${req.file.filename}${ext}`;
    const finalPath = path.join(mediaDir, finalName);
    fs.renameSync(req.file.path, finalPath);

    const base = publicBaseUrl(req);
    const mediaUrl = `${base}/media/${encodeURIComponent(finalName)}`;

    const jobs = read(jobsFile);
    selected.forEach((account, index) => {
      jobs.push({
        id: newId(),
        accountId: account.id,
        accountLabel: account.label,
        igUserId: account.igUserId,
        fileName: req.file.originalname,
        mediaUrl,
        caption: cfg.caption || "",
        scheduledAt: new Date(scheduleTimes[index]).toISOString(),
        status: "scheduled",
        createdAt: new Date().toISOString(),
        error: null,
        publishedMediaId: null
      });
    });

    write(jobsFile, jobs);
    res.json({
      ok: true,
      created: selected.length,
      mediaUrl
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(400).json({ error: error.message });
  }
});

async function graph(pathname, params, token, method = "POST") {
  const url = new URL(`https://graph.facebook.com/${GRAPH}/${pathname}`);

  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value));
  }
  url.searchParams.set("access_token", token);

  const response = await fetch(url, { method });
  const json = await response.json();

  if (!response.ok || json.error) {
    throw new Error(json.error?.message || `Meta API HTTP ${response.status}`);
  }
  return json;
}

async function publish(job, account) {
  const token = decrypt(account.tokenEnc);

  const containerResponse = await graph(
    `${account.igUserId}/media`,
    {
      media_type: "REELS",
      video_url: job.mediaUrl,
      caption: job.caption,
      share_to_feed: "true"
    },
    token
  );

  const creationId = containerResponse.id;
  const deadline = Date.now() + 12 * 60_000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));

    const status = await graph(
      creationId,
      { fields: "status_code,status" },
      token,
      "GET"
    );

    if (status.status_code === "FINISHED") {
      const published = await graph(
        `${account.igUserId}/media_publish`,
        { creation_id: creationId },
        token
      );
      return published.id;
    }

    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`Instagram container status: ${status.status_code}`);
    }
  }

  throw new Error("Timed out waiting for Instagram video processing.");
}

let busy = false;

async function runDueJobs() {
  if (busy) return;
  busy = true;

  try {
    const accounts = read(accountsFile);
    const jobs = read(jobsFile);

    for (const job of jobs) {
      if (job.status !== "scheduled") continue;
      if (new Date(job.scheduledAt).getTime() > Date.now()) continue;

      const account = accounts.find((a) => a.id === job.accountId);

      if (!account) {
        job.status = "failed";
        job.error = "Connected account not found.";
        write(jobsFile, jobs);
        continue;
      }

      job.status = "publishing";
      job.error = null;
      write(jobsFile, jobs);

      try {
        job.publishedMediaId = await publish(job, account);
        job.status = "published";
        job.publishedAt = new Date().toISOString();
      } catch (error) {
        job.status = "failed";
        job.error = error.message;
      }

      write(jobsFile, jobs);
    }
  } finally {
    busy = false;
  }
}

setInterval(runDueJobs, 30_000);
runDueJobs();

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Insta Auto Publisher backend running on port ${PORT}`);
});
