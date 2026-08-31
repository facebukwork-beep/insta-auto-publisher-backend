# Insta Auto Publisher — Render Ready

This folder is ready to upload to GitHub and deploy on Render.

## Easiest setup

### 1. Upload this folder to GitHub
Create a new GitHub repository and upload all files from this folder.

Important: upload `render.yaml`, `server.js`, and `package.json` at the repository root.

### 2. Deploy on Render
1. Open Render.
2. Choose New → Blueprint.
3. Connect the GitHub repository.
4. Render will detect `render.yaml`.
5. Create/deploy the service.

The Blueprint automatically configures:
- Node runtime
- `npm install`
- `npm start`
- `/api/health` health check
- a generated `APP_SECRET_KEY`

### 3. After deploy
Open:

`https://YOUR-SERVICE.onrender.com/api/health`

You should see JSON with `"ok": true`.

### 4. Put Render URL in the Chrome extension
Example:

`https://insta-auto-publisher-xxxx.onrender.com`

Do not add `/api/health` to the extension URL.

### 5. Connect Instagram accounts
Inside the extension add:
- Account label / username
- Instagram User ID
- Valid Meta access token

For real publishing, the Instagram account and Meta app must be eligible for Instagram's official publishing API and have the required permissions.

## Random scheduler
Choose:
- Posting date
- From time
- To time
- Up to 15 accounts

The backend creates separate random posting times and publishes jobs when they become due.

## Important Render storage note
The example stores uploaded videos, account data, and jobs on the server filesystem. On hosts with ephemeral filesystems, files can disappear after redeploy/restart. For serious long-term use, move media and job/account storage to persistent storage/database/object storage.

## Graph API version
`render.yaml` currently provides a starter `GRAPH_API_VERSION`. Check your Meta developer dashboard and change it to a currently supported version when needed.
