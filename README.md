# Insta Auto Publisher v14.0 — Durable Backend

This release prevents the main failure mode of earlier versions: accounts/jobs/video files disappearing after a Render restart or redeploy.

## What changed

- PostgreSQL-backed account/job state (`DATABASE_URL`)
- S3-compatible persistent public video storage (Cloudflare R2 / S3)
- Safe scheduling gate: by default `/api/schedule` is blocked until **both** state and media are restart-safe
- Important API mutations wait for durable state flush before returning success
- Scheduler remains advisory-lock protected when PostgreSQL is enabled
- Published media objects can be cleaned automatically after `KEEP_MEDIA_AFTER_PUBLISH_HOURS`
- `/api/storage-status` tells you whether it is actually safe to bulk schedule

## Two supported durable modes

### A. Persistent disk
Set `PERSISTENT_ROOT=/var/data` and mount a real persistent disk there. This stores state + media on one disk.

### B. PostgreSQL + S3/R2 (recommended on a stateless Render web service)
Set `DATABASE_URL` plus the S3 variables from `.env.example`.

For Instagram publishing, `S3_PUBLIC_BASE_URL` must serve files publicly because Meta fetches the video URL from its own servers.

## Safety check

After deploy, open `/api/storage-status`. Do not bulk schedule until you see:

```json
{
  "restartSafe": true,
  "safeToSchedule": true
}
```

If storage is not durable, v14 returns HTTP 503 for new scheduling instead of accepting hundreds of jobs that could later disappear.

## Existing extensions

The laptop extension and mobile PWA can keep using the same backend URL and API. No UI update is required for v14.
