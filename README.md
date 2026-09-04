# Insta Auto Publisher v14.1 — Neon + Google Drive Durable Backend

This version supports a no-R2-payment path:

- **Neon PostgreSQL**: accounts, scheduled jobs, published history, scheduler state
- **Google Drive**: video files
- **Render**: API + scheduler + secure media proxy to Meta/Instagram

When `DATABASE_URL` and the four `GDRIVE_*` variables are configured, `/api/storage-status` should report:

- `state: "postgres"`
- `media: "gdrive"`
- `statePersistent: true`
- `mediaPersistent: true`
- `restartSafe: true`
- `safeToSchedule: true`

## Google Drive variables

Set these on Render:

- `GDRIVE_CLIENT_ID`
- `GDRIVE_CLIENT_SECRET`
- `GDRIVE_REFRESH_TOKEN`
- `GDRIVE_FOLDER_ID`

Use Google OAuth scope `https://www.googleapis.com/auth/drive.file`.

For a personal Google account, put the OAuth consent app in **Production** before relying on the refresh token long-term; testing-mode refresh tokens for external apps can expire quickly.

## Storage usage

Set `KEEP_MEDIA_AFTER_PUBLISH_HOURS=2` (or another small number) so media is removed from Drive after all jobs referencing that video are published. This is important for large daily volumes because personal Google Drive has finite storage.

## Important

Do not change `APP_SECRET_KEY` or existing encrypted account recovery blobs may stop decrypting.
