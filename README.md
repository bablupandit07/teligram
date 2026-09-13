# Flow Telegram workspace

Single-user Node.js Telegram browser, with file-based storage and no database.

## Render

Push the allowed app files to your GitHub repository. In Render choose New > Blueprint and select the repository. The render.yaml creates a PAID Starter web service with a 1 GB persistent disk. Review the cost before deploying.

Set APP_PASSWORD to a unique random password of at least 16 characters when prompted. Open the HTTPS service URL; use any username and that password. Enter Telegram credentials in Settings, then complete login. Never put Telegram credentials in Git.

Alternatively create a Node Web Service: build `npm install --omit=dev`, start `npm start`, HOST `0.0.0.0`, APP_PASSWORD set, APP_DATA_DIR `/var/data/flow`, health check `/healthz`. Attach a persistent disk at `/var/data`.

The disk holds sensitive plaintext Telegram credentials, session and forwarding checkpoints. Do not share it or commit it. Free/ephemeral storage will not reliably preserve this state across deployments. Local checkpoints are not automatically transferred to Render: old forwarded messages are not known on a fresh deployment.

Only one instance/account is supported. This is not a multi-user service. Keep the browser open for active forwarding; the current forwarding loop runs in the page. Telegram cooldowns and protected-content restrictions still apply.

## Local

Node 22: `npm install`, then `npm start`. Open http://127.0.0.1:3210. Without APP_DATA_DIR, private state stays in .telegram-view.

The Git allowlist excludes old CLI scripts, all media, Excel files, caches and sessions. No local files were deleted.
