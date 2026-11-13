# 部署到 Railway（含 Volume 持久化）

本项目是单实例 Node.js 服务：HTTP + WebSocket 同端口，房间数据写入 `DATA_DIR/rooms.json`。
文件存储不支持多副本，因此 Railway 上必须保持 **1 个实例**（不要扩容副本），并挂载 Volume。

## 1. 推送到 GitHub

```sh
git init
git add .
git commit -m "Dandong 50K realtime"
git branch -M main
git remote add origin git@github.com:<你的账号>/dandong-50k.git
git push -u origin main
```

`node_modules/` 与 `data/` 已在 `.gitignore` 中忽略；请提交 `package-lock.json`。

## 2. 在 Railway 新建服务

1. 打开 [Railway](https://railway.app/) → **New Project** → **Deploy from GitHub repo**，选择仓库。
2. 构建使用 Nixpacks，启动命令、健康检查由仓库根目录的 `railway.json` 指定：
   - `startCommand`: `npm start`
   - `healthcheckPath`: `/healthz`
   - 失败自动重启（`ON_FAILURE`，最多 10 次）。
3. 服务启动后打开 **Settings → Networking → Generate Domain**，得到公网域名（HTTPS）。

WebSocket 自动使用同域名：前端连接 `wss://<域名>/ws`，无需额外配置。

## 3. 挂载 Volume（必须）

1. 服务页 → **Volumes** → **Add Volume**。
2. 挂载路径填 `/data`。
3. 服务 **Variables** 增加：

| 变量 | 值 | 说明 |
|---|---|---|
| `DATA_DIR` | `/data` | 房间持久化目录（默认 `./data`） |
| `TURN_SECONDS` | `40`（可选） | 每回合倒计时秒数，可改小方便测试 |
| `BOT_DELAY_MS` | `900`（可选） | 机器人思考延迟 |
| `ROOM_TTL_HOURS` | `24`（可选） | 无活动房间清理时间 |

4. 重新部署（Redeploy）。健康检查访问 `https://<域名>/healthz` 应返回 `{"ok":true,...}`。

> 不挂 Volume 时，每次重新部署都会丢失所有房间与比分。

## 4. 说明与限制

- **只允许单实例**：`rooms.json` 是本地文件，多副本之间不会同步。请保持 Railway 副本数为 1。
- 服务收到 `SIGTERM` 时会同步落盘再退出；正常重启会恢复房间、比分、手牌与当前倒计时。
- 房间 24 小时无活动会被清理；单进程最多 500 个房间，超出时淘汰最久未活动的空房。
- 身份 token 只保存在玩家浏览器 `localStorage`，服务端仅存 `sha256` 摘要；换设备/清缓存后需重新加入。
- 房间链接形如 `https://<域名>/#room=ABC123`，发给朋友即可加入（已开局的房间不允许新玩家中途加入）。

## 5. 本地等价运行

```sh
npm install
TURN_SECONDS=5 DATA_DIR=./data npm start
```

浏览器打开 `http://localhost:8787`；两个浏览器或一个浏览器 + 5 个机器人即可验证实时同步与倒计时。`npm test` 会以随机端口和临时目录自动跑完整冒烟测试。
