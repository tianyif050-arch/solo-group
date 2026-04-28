# 公网部署（GitHub Pages + Render）

## 1. 部署后端（Render）

1. 打开 [Render Dashboard](https://dashboard.render.com/blueprint/new)。
2. 选择你的仓库 `tianyif050-arch/solo-group`，Render 会识别根目录的 `render.yaml`。
3. Render 构建使用 `backend/requirements-render.txt`（已去掉 `vosk`，避免云端构建失败）。
4. 创建后会得到两个公网地址：
   - `solo-group-api`（HTTP API）
   - `solo-group-ws`（WebSocket）
5. 在这两个服务里都设置 LLM 环境变量（二选一）：
   - 推荐：`ZHIPU_API_KEY`
   - 或者：`OPENAI_API_KEY` + `OPENAI_BASE_URL`（可选 `OPENAI_MODEL`）

## 2. 配置前端构建变量（GitHub 仓库）

在 GitHub 仓库 `Settings -> Secrets and variables -> Actions -> Variables` 新建：

- `VITE_API_URL`：`https://<solo-group-api域名>`
- `VITE_BACKEND_URL`：`https://<solo-group-api域名>`
- `VITE_GROUP_API_URL`：`https://<solo-group-ws域名>`
- `VITE_WS_URL`：`wss://<solo-group-ws域名>/ws`
- `VITE_GROUP_WS_URL`：`wss://<solo-group-ws域名>/ws`

## 3. 启用 GitHub Pages

1. 打开仓库 `Settings -> Pages`。
2. `Build and deployment` 里选择 `Source: GitHub Actions`。
3. 推送一次 `main` 分支（或手动运行 `Deploy Frontend To GitHub Pages` 工作流）。

## 4. 前端公网地址

- `https://tianyif050-arch.github.io/solo-group/`
