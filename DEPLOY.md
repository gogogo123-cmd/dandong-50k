# 部署到 Railway（含 Volume 持久化）

本项目是单实例 Node.js 服务：HTTP + WebSocket 同端口，房间数据写入 `DATA_DIR/rooms.json`。
文件存储不支持多副本，因此 Railway 上必须保持 **1 个实例**（不要扩容副本），并挂载 Volume。

部署配置使用 Railway 新的 Infrastructure as Code 文件：`.railway/railway.ts`，声明了 Nixpacks 构建、启动命令、健康检查、1 个副本和 `/data` Volume。

## 1. 推送到 GitHub

```sh
git init
git add .
git commit -m "Dandong 50K realtime"
git branch -M main
git remote add origin git@github.com:<你的账号>/dandong-50k.git
git push -u origin main
```

`node_modules/` 与 `data/` 已在 `.gitignore` 中忽略；请提交 `package-lock.json` 与 `.railway/railway.ts`。

## 2. 在 Railway 创建项目

**方式 A：GitHub 自动部署（推荐）**

1. 打开 [Railway](https://railway.app/) → **New Project** → **Deploy from GitHub repo**，选择仓库。
2. 首次使用需安装 Railway GitHub App 并授权该仓库。
3. 之后每次 `git push` 到 `main` 自动构建部署。

**方式 B：CLI 直接部署**

```sh
railway login
railway init --name dandong-50k   # 首次；或在已有项目内 railway link
railway up -d                     # 上传当前目录并部署
```

> 运行服务本身只需 Node 20；`railway config plan/apply` 的 IaC 求值需要本机 Node 22+。

## 3. Volume 与环境变量

`.railway/railway.ts` 已声明：

- Volume `carefree-trust-volume`（500MB）挂载到 **`/data`**
- Nixpacks 构建、`npm start`、健康检查 `/healthz`、单副本

在服务 **Variables** 中设置（IaC 不管理变量）：

| 变量 | 值 | 说明 |
|---|---|---|
| `DATA_DIR` | `/data` | 房间持久化目录（默认 `./data`） |
| `TURN_SECONDS` | `40`（可选） | 每回合倒计时秒数，可改小方便测试 |
| `BOT_DELAY_MS` | `900`（可选） | 机器人思考延迟 |
| `ROOM_TTL_HOURS` | `24`（可选） | 无活动房间清理时间 |

应用 IaC：

```sh
npm install                 # 安装 railway devDependency
railway config plan         # 预览，确认没有销毁 Volume 等破坏性变更
railway config apply
```

服务 → **Settings → Networking → Generate Domain** 得到公网域名；WebSocket 自动使用同域名的 `wss://<域名>/ws`。

健康检查：`https://<域名>/healthz` 应返回 `{"ok":true,...}`。

> 不挂 Volume 时，每次重新部署都会丢失所有房间与比分。`railway config plan` 中若出现 `volumeAttachments ... → null`，说明 IaC 文件缺少 Volume 声明，不要执行 apply。

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
