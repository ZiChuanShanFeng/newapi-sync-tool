# NewAPI SYNC TOOL
 [中文](README.zh-CN.md)

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/G3451V)

NewAPI Sync Tool (Node.js + Express).

## DEMO
[Frontend Demo](https://testnewapi.zeabur.app/#)

## TOKEN
The access token can be obtained from Personal Settings - Security Settings - System Service Token.

## Requirements
- Node.js 18+

## Local run
```bash
npm install
npm start
```
Open `http://localhost:8083`.

## Environment variables
- `PORT`: server port (default `8083`)
- `SECRET_KEY`: encryption key for `config.json` (default `newapi-sync-tool-2024`)
- `CONFIG_DIR`: directory for `config.json` and `monitor-config.json` (default project root)
- `ALLOWED_ORIGINS`: comma-separated CORS allowlist (e.g. `https://app.example.com`). When unset, all origins are allowed.

## Security notes
- The access token is **never** stored in the browser. It is sent to the server once, encrypted with `SECRET_KEY`, and stored in `config.json`. Subsequent requests omit the token and the server fills it in automatically (only for the matching server URL), so you enter it once.
- **Set a strong random `SECRET_KEY`** (e.g. `SECRET_KEY=$(openssl rand -hex 32)`). With the default key, anyone who reads `config.json` can decrypt the token. The server prints a warning at startup when the default key is in use.
- This tool has no built-in authentication. When exposing it publicly, place it behind an authenticated reverse proxy and set `ALLOWED_ORIGINS`.

## Docker
```bash
docker build -t newapi-elegant .
docker run -d --name newapi-elegant \
  -p 8083:8083 \
  -e PORT=8083 \
  -e SECRET_KEY=change-me \
  -e CONFIG_DIR=/data \
  -v ./data:/data \
  newapi-elegant
```

## Docker Compose
```bash
docker compose up -d
```

## Zeabur (one-click deploy)
1) Push this repo to GitHub.
2) Create a Zeabur project from the GitHub repo (Dockerfile deploy is recommended).
3) Set environment variables: `PORT`, `SECRET_KEY`, `CONFIG_DIR`.
4) Add a persistent volume and mount it to `/data`, then set `CONFIG_DIR=/data`.
5) Create a Zeabur template and copy the deploy button code into this README.

Button link format :

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/G3451V)


## PaaS notes
This app needs a long-running Node process and writes config files on disk.
Serverless runtimes (Cloudflare Workers/Pages Functions, Vercel/Netlify Functions)
are not a good fit without a rewrite.

Platforms that work well for this style:
- Render, Railway, Fly.io, Koyeb, Zeabur, or any VPS + Docker

General steps:
1) Connect the GitHub repo.
2) Build: `npm ci --omit=dev` (or `npm install`)
3) Start: `npm start`
4) Set `PORT`, `SECRET_KEY`, `CONFIG_DIR` (use a persistent disk path if supported)

## Git hygiene
Do not commit `node_modules/`, `config.json`, or `monitor-config.json`.


## License

This project is licensed under the [MIT](https://github.com/ZiChuanShanFeng/newapi-sync-tool/blob/main/License.md) License.

