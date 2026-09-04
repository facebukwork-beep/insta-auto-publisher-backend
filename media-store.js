import fs from "fs";
import path from "path";
import crypto from "crypto";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

export function createMediaStore({ mediaDir, persistentRoot }) {
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
