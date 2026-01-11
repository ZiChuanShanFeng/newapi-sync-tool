# NewAPI SYNC TOOL

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/G3451V)

NewAPI 同步工具（Node.js + Express）。

## 访问令牌
访问令牌的话是从个人设置 - 安全设置 - 系统服务令牌获取

## 运行环境
- Node.js 18+

## 本地运行
```bash
npm install
npm start
```
打开 `http://localhost:8083`。

## 环境变量
- `PORT`: 服务端口（默认 `8083`）
- `SECRET_KEY`: `config.json` 的加密密钥（默认 `newapi-sync-tool-2024`）
- `CONFIG_DIR`: `config.json` 与 `monitor-config.json` 存储目录（默认项目根目录）

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

## Zeabur（一键部署）
1) 将仓库推到 GitHub。
2) 从 GitHub 创建 Zeabur 项目（建议 Dockerfile 部署）。
3) 设置环境变量：`PORT`、`SECRET_KEY`、`CONFIG_DIR`。
4) 添加持久化磁盘并挂载到 `/data`，然后设置 `CONFIG_DIR=/data`。
5) 创建 Zeabur 模板，并把部署按钮代码放到 README。

按钮链接格式：

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/G3451V)


## PaaS 说明
此应用需要常驻进程并写入本地文件。
Serverless 运行时（Cloudflare Workers/Pages Functions、Vercel/Netlify Functions）
不适合当前实现，除非重写。

适合的平台：
- Render、Railway、Fly.io、Koyeb、Zeabur，或任意 VPS + Docker

通用步骤：
1) 连接 GitHub 仓库。
2) Build: `npm ci --omit=dev`（或 `npm install`）。
3) Start: `npm start`。
4) 设置 `PORT`、`SECRET_KEY`、`CONFIG_DIR`（如有持久化磁盘请指向持久化路径）。

## Git 提交注意
不要提交 `node_modules/`、`config.json` 或 `monitor-config.json`。
