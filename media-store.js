import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

function createGoogleDriveStore() {
  const clientId = String(process.env.GDRIVE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GDRIVE_CLIENT_SECRET || "").trim();
  const refreshToken = String(process.env.GDRIVE_REFRESH_TOKEN || "").trim();
  const folderId = String(process.env.GDRIVE_FOLDER_ID || "").trim();
  const configured = Boolean(clientId && clientSecret && refreshToken);
  if (!configured) return null;

  let cachedToken = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    });
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || `Google OAuth HTTP ${r.status}`);
    cachedToken = j.access_token;
    tokenExpiresAt = Date.now() + Number(j.expires_in || 3600) * 1000;
    return cachedToken;
  }

  async function uploadResumable(file, originalName) {
    const token = await accessToken();
    const stat = fs.statSync(file.path);
    const safeName = `${Date.now()}-${crypto.randomUUID()}-${path.basename(originalName || "video.mp4")}`;
    const metadata = { name: safeName };
    if (folderId) metadata.parents = [folderId];

    const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,mimeType", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.mimetype || "video/mp4",
        "X-Upload-Content-Length": String(stat.size)
      },
      body: JSON.stringify(metadata)
    });
    if (!init.ok) {
      const t = await init.text();
      throw new Error(`Google Drive upload init failed (${init.status}): ${t.slice(0, 300)}`);
    }
    const location = init.headers.get("location");
    if (!location) throw new Error("Google Drive resumable upload URL was not returned.");

    const up = await fetch(location, {
      method: "PUT",
      headers: {
        "Content-Type": file.mimetype || "video/mp4",
        "Content-Length": String(stat.size)
      },
      body: fs.createReadStream(file.path),
      duplex: "half"
    });
    const json = await up.json().catch(() => ({}));
    if (!up.ok || !json.id) throw new Error(`Google Drive upload failed (${up.status}): ${JSON.stringify(json).slice(0, 300)}`);
    try { fs.unlinkSync(file.path); } catch (_) {}
    return json.id;
  }

  async function streamFile(fileId, req, res) {
    const token = await accessToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (req.headers.range) headers.Range = req.headers.range;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
    if (!r.ok && r.status !== 206) {
      const t = await r.text().catch(() => "");
      return res.status(r.status).send(`Drive media fetch failed: ${t.slice(0, 200)}`);
    }
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(r.status);
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).pipe(res);
  }

  return {
    mode: "gdrive",
    durable: true,
    publicBase: null,
    async put(file, originalName, baseUrl) {
      const fileId = await uploadResumable(file, originalName);
      return { mediaUrl: `${baseUrl}/drive-media/${encodeURIComponent(fileId)}`, storageKey: fileId };
    },
    async remove(job) {
      const fileId = job?.storageKey;
      if (!fileId) return;
      const token = await accessToken();
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok && r.status !== 404) throw new Error(`Google Drive delete failed (${r.status})`);
    },
    async stream(fileId, req, res) {
      return streamFile(fileId, req, res);
    }
  };
}

export function createMediaStore({ mediaDir, persistentRoot }) {
  // Prefer Google Drive when explicitly configured. It needs no paid object-storage account.
  const drive = createGoogleDriveStore();
  if (drive) return drive;

  const endpoint = String(process.env.S3_ENDPOINT || "").trim();
  const bucket = String(process.env.S3_BUCKET || "").trim();
  const accessKeyId = String(process.env.S3_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(process.env.S3_SECRET_ACCESS_KEY || "").trim();
  const publicBase = String(process.env.S3_PUBLIC_BASE_URL || "").trim().replace(/\/$/, "");
  const region = String(process.env.S3_REGION || "auto").trim();
  const configured = Boolean(endpoint && bucket && accessKeyId && secretAccessKey && publicBase);

  if (configured) {
    const client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || "false").toLowerCase() === "true"
    });
    return {
      mode: "s3",
      durable: true,
      publicBase,
      async put(file, originalName) {
        const ext = path.extname(originalName) || ".mp4";
        const key = `media/${new Date().toISOString().slice(0,10)}/${crypto.randomUUID()}${ext}`;
        await client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: fs.createReadStream(file.path),
          ContentType: file.mimetype || "video/mp4",
          CacheControl: "public, max-age=86400"
        }));
        try { fs.unlinkSync(file.path); } catch (_) {}
        const encodedKey = key.split("/").map(encodeURIComponent).join("/");
        return { mediaUrl: `${publicBase}/${encodedKey}`, storageKey: key };
      },
      async remove(job) {
        if (!job?.storageKey) return;
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: job.storageKey }));
      }
    };
  }

  fs.mkdirSync(mediaDir, { recursive: true });
  return {
    mode: persistentRoot ? "disk" : "local",
    durable: Boolean(persistentRoot),
    publicBase: null,
    async put(file, originalName, baseUrl) {
      const ext = path.extname(originalName) || ".mp4";
      const finalName = `${file.filename}${ext}`;
      fs.renameSync(file.path, path.join(mediaDir, finalName));
      return { mediaUrl: `${baseUrl}/media/${encodeURIComponent(finalName)}`, storageKey: finalName };
    },
    async remove(job) {
      const name = job?.storageKey || (() => { try { return path.basename(new URL(job.mediaUrl).pathname); } catch { return null; } })();
      if (!name) return;
      const p = path.join(mediaDir, decodeURIComponent(name));
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    }
  };
}
