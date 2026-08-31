# Insta Auto Publisher v8 — Render Backend

New in v8:
- Exact local-time fix: browser converts the chosen local time to ISO/UTC before sending it to Render, removing server-timezone drift.
- Future posts are pre-processed up to 10 minutes early, then `media_publish` is called at the scheduled time.
- Selecting the current minute starts publishing immediately instead of moving the job to a later time.
- Multiple videos + multiple accounts: every selected video is scheduled to every selected account (max 30 videos, 15 accounts, 300 generated jobs per batch).
- Duplicate-account protection and account removal remain enabled.

## Render
Build: `npm install`
Start: `npm start`

Required env vars:
- `APP_SECRET_KEY` — any strong secret (Render can generate one)
- `GRAPH_API_VERSION` — e.g. `v23.0`

Optional:
- `PREPARE_AHEAD_MINUTES=10`
- `PUBLIC_BASE_URL` (normally not needed on Render; `RENDER_EXTERNAL_URL` is detected automatically)

## Important reliability note
A free Render web service can sleep when inactive. Exact unattended posting cannot be guaranteed while the service is asleep. An always-on instance is recommended for timing-sensitive production use. Render's local filesystem is also ephemeral, so production use should move accounts/jobs/media to persistent storage.
