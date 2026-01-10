# NewAPI SYNC TOOL
 [中文](README.zh-CN.md)

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/G3451V)

NewAPI Sync Tool (Node.js + Express).



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

Button link format (replace with your template):
```
[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/G3451V)
```

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
