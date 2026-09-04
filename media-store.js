import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

function createGoogleDriveStore({ getRefreshToken } = {}) {
  const clientId = String(process.env.GDRIVE_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.GDRIVE_CLIENT_SECRET || "").trim();
  const envRefreshToken = String(process.env.GDRIVE_REFRESH_TOKEN || "").trim();
  const configuredFolderId = String(process.env.GDRIVE_FOLDER_ID || "").trim();
  const folderName = String(process.env.GDRIVE_FOLDER_NAME || "Insta Auto Publisher Media").trim() || "Insta Auto Publisher Media";
  const configured = Boolean(clientId && clientSecret);
  if (!configured) return null;

  function currentRefreshToken() {
    return String((typeof getRefreshToken === "function" ? getRefreshToken() : "") || envRefreshToken || "").trim();
  }

  let cachedToken = null;
  let tokenExpiresAt = 0;
  let cachedFolderId = null;
  let folderPromise = null;

  async function readGoogleJson(r) {
    const text = await r.text();
    try { return text ? JSON.parse(text) : {}; } catch { return { raw: text }; }
  }

  function googleError(prefix, r, payload) {
    const detail = payload?.error?.message || payload?.error_description || payload?.error || payload?.raw || `HTTP ${r.status}`;
    const reason = payload?.error?.errors?.[0]?.reason;
    return new Error(`${prefix} (${r.status})${reason ? ` [${reason}]` : ""}: ${String(detail).slice(0, 500)}`);
  }

  async function accessToken(force = false) {
    if (!force && cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;
    const refreshToken = currentRefreshToken();
    if (!refreshToken) throw new Error("Google Drive is not connected. Open /api/google-drive/connect to authorize Drive.");
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
    const j = await readGoogleJson(r);
    if (!r.ok || !j.access_token) {
      const err = googleError("Google OAuth refresh failed", r, j);
      err.message += " — reconnect at /api/google-drive/connect";
      throw err;
    }
    cachedToken = j.access_token;
    tokenExpiresAt = Date.now() + Number(j.expires_in || 3600) * 1000;
    return cachedToken;
  }

  async function driveFetch(url, options = {}, retryAuth = true) {
    let token = await accessToken();
    let r = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
    if (r.status === 401 && retryAuth) {
      cachedToken = null; tokenExpiresAt = 0;
      token = await accessToken(true);
      r = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
    }
    return r;
  }

  async function folderUsable(id) {
    if (!id) return false;
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,trashed&supportsAllDrives=true`);
    if (!r.ok) return false;
    const j = await readGoogleJson(r);
    return Boolean(j.id && !j.trashed && j.mimeType === "application/vnd.google-apps.folder");
  }

  async function findAppFolder() {
    const q = `name='${folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&spaces=drive&fields=files(id,name,createdTime)&orderBy=createdTime&pageSize=10`);
    if (!r.ok) return null;
    const j = await readGoogleJson(r);
    return Array.isArray(j.files) && j.files.length ? j.files[0].id : null;
  }

  async function createAppFolder() {
    const r = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder" })
    });
    const j = await readGoogleJson(r);
    if (!r.ok || !j.id) throw googleError("Google Drive folder creation failed", r, j);
    return j.id;
  }

  async function resolveFolderId() {
    if (cachedFolderId) return cachedFolderId;
    if (folderPromise) return folderPromise;
    folderPromise = (async () => {
      // drive.file cannot always use a folder that was manually created outside the app.
      // Prefer the configured folder when accessible; otherwise automatically reuse/create
      // an app-owned folder that drive.file is guaranteed to manage.
      if (configuredFolderId && await folderUsable(configuredFolderId)) {
        cachedFolderId = configuredFolderId;
        return cachedFolderId;
      }
      const found = await findAppFolder();
      if (found) {
        cachedFolderId = found;
        return cachedFolderId;
      }
      cachedFolderId = await createAppFolder();
      return cachedFolderId;
    })().finally(() => { folderPromise = null; });
    return folderPromise;
  }

  async function uploadResumable(file, originalName) {
    const token = await accessToken();
    const stat = fs.statSync(file.path);
    const safeName = `${Date.now()}-${crypto.randomUUID()}-${path.basename(originalName || "video.mp4")}`;
    const folderId = await resolveFolderId();
    const metadata = { name: safeName, parents: [folderId] };

    const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,mimeType,parents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": file.mimetype || "video/mp4",
        "X-Upload-Content-Length": String(stat.size)
      },
      body: JSON.stringify(metadata)
    });
    const initPayload = await readGoogleJson(init);
    if (!init.ok) throw googleError("Google Drive upload init failed", init, initPayload);
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
    const json = await readGoogleJson(up);
    if (!up.ok || !json.id) throw googleError("Google Drive upload failed", up, json);
    try { fs.unlinkSync(file.path); } catch (_) {}
    return json.id;
  }

  async function streamFile(fileId, req, res) {
    const token = await accessToken();
    const headers = { Authorization: `Bearer ${token}` };
    if (req.headers.range) headers.Range = req.headers.range;
    let r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
    if (r.status === 401) {
      cachedToken = null; tokenExpiresAt = 0;
      const retryToken = await accessToken(true);
      headers.Authorization = `Bearer ${retryToken}`;
      r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
    }
    if (!r.ok && r.status !== 206) {
      const t = await r.text().catch(() => "");
      return res.status(r.status).send(`Drive media fetch failed: ${t.slice(0, 400)}`);
    }
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
      const v = r.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.status(r.status);
    if (!r.body) return res.end();
    Readable.fromWeb(r.body).pipe(res);
  }

  async function selfTest() {
    const token = await accessToken(true);
    const folderId = await resolveFolderId();
    const name = `.insta-auto-publisher-test-${Date.now()}.txt`;
    const boundary = `iap-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name, parents: [folderId] });
    const content = `drive-test ${new Date().toISOString()}`;
    const body = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`);
    const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,parents", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(body.length) },
      body
    });
    const j = await readGoogleJson(r);
    if (!r.ok || !j.id) throw googleError("Google Drive test upload failed", r, j);
    const del = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(j.id)}`, { method: "DELETE" });
    if (!del.ok && del.status !== 404) {
      const dj = await readGoogleJson(del);
      throw googleError("Google Drive test cleanup failed", del, dj);
    }
    return { ok: true, folderId, uploadedAndDeleted: true };
  }

  return {
    mode: "gdrive",
    get durable() { return Boolean(currentRefreshToken()); },
    publicBase: null,
    async put(file, originalName, baseUrl) {
      const fileId = await uploadResumable(file, originalName);
      return { mediaUrl: `${baseUrl}/drive-media/${encodeURIComponent(fileId)}`, storageKey: fileId };
    },
    async remove(job) {
      const fileId = job?.storageKey;
      if (!fileId) return;
      const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
      if (!r.ok && r.status !== 404) {
        const j = await readGoogleJson(r);
        throw googleError("Google Drive delete failed", r, j);
      }
    },
    async stream(fileId, req, res) {
      return streamFile(fileId, req, res);
    },
    async selfTest() { return selfTest(); },
    async folderInfo() {
      const id = await resolveFolderId();
      return { folderId: id, configuredFolderId: configuredFolderId || null, usingConfiguredFolder: Boolean(configuredFolderId && id === configuredFolderId), folderName };
    }
  };
}

export function createMediaStore({ mediaDir, persistentRoot, getDriveRefreshToken }) {
  // Prefer Google Drive when explicitly configured. It needs no paid object-storage account.
  const drive = createGoogleDriveStore({ getRefreshToken: getDriveRefreshToken });
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
