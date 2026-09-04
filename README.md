# Insta Auto Publisher v14.3 — One-Click Google Drive OAuth

This release fixes repeated Google Drive OAuth refresh-token/client-secret mismatch errors by moving Drive authorization into the backend itself.

## What changes

- `/api/google-drive/connect-info` shows the exact OAuth callback URI for this backend.
- `/api/google-drive/connect` starts Google authorization using the same `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` that the backend will later use.
- `/api/google-drive/oauth/callback` exchanges the code and stores the Google refresh token **encrypted** in durable Postgres/Neon state.
- `/api/drive-test` verifies upload + delete.
- `GDRIVE_REFRESH_TOKEN` remains only as a fallback; after one-click connect, the DB token takes priority.
- Existing Neon jobs/history, Google Drive media, auto-delete-after-publish, account recovery, scheduler and Meta publishing behavior remain unchanged.

## One-time Google Cloud setting

In Google Cloud → Google Auth Platform → Clients → `Insta Auto Publisher Drive Web`, add this **Authorized redirect URI**:

`https://insta-auto-publisher-backend.onrender.com/api/google-drive/oauth/callback`

If you use another backend hostname, get the exact URI from:

`https://YOUR-BACKEND/api/google-drive/connect-info`

## Then connect Drive

Open:

`https://insta-auto-publisher-backend.onrender.com/api/google-drive/connect`

Choose your Google account and Allow. The backend saves the refresh token encrypted in Postgres.

Then test:

`https://insta-auto-publisher-backend.onrender.com/api/drive-test`

Expected: `ok: true` and `uploadedAndDeleted: true`.

## Required Render env vars

- `APP_SECRET_KEY`
- `DATABASE_URL`
- `GDRIVE_CLIENT_ID`
- `GDRIVE_CLIENT_SECRET`
- `GDRIVE_FOLDER_ID` (optional; app can create/reuse its own folder)
- `KEEP_MEDIA_AFTER_PUBLISH_HOURS=2`

After one-click connect, `GDRIVE_REFRESH_TOKEN` is no longer required.
