# 闹钟 Agent

[![CI](https://github.com/Gablesandvines/alarm-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Gablesandvines/alarm-agent/actions/workflows/ci.yml)

> 中文自然语言的「定时能力平台」。把"明早 8 点叫我""周五下午 3 点半开会"这样的口语，解析成结构化闹钟；并进一步提供**托管闹钟 + 到点 Webhook 事件投递**，让你无需自建调度即可接入"定时触发业务"。最小化服务端、数据自托管。

---

## ✨ 特性

- **自然语言解析**：中文口语 → 结构化闹钟 JSON（规则引擎优先，可选 LLM 长尾兜底）。
- **托管闹钟**：服务端到点自动触发，无需你自己跑定时器。
- **Webhook 投递**：触发时向你的回调地址投递 `alarm.fired` 事件，附带 **HMAC-SHA256 签名**，可验真伪。
- **多租户 API Key**：Bearer 鉴权、按 key 限流、租户数据隔离。
- **开发者门户**：`/portal` 单页控制台，自助管理密钥、配置 Webhook、查看用量看板。
- **三档套餐**：`free` / `pro` / `enterprise`，含月度解析配额。
- **自托管、零外部依赖**：数据存本地 SQLite（Node 22 内置 `node:sqlite`），不依赖外部数据库或云服务。

---

## 🧱 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Node.js 22（内置 `node:sqlite`） |
| 持久化 | SQLite 单文件（`data/alarm.db`），自动建表 + 旧 JSON 自动迁移 |
| 兜底推送 | `web-push`（参考 App 的浏览器系统通知） |
| 生产 HTTPS | Caddy 自动申请/续期 Let's Encrypt 证书 |
| 部署 | Docker / Docker Compose |

---

## 🚀 快速开始

### 方式一：本地直接跑（最简单）

```bash
git clone <本仓库> alarm_agent && cd alarm_agent
npm install
node server.js            # 默认监听 8080，可用 PORT=xxxx 覆盖
```

浏览器打开：
- `http://localhost:8080` — 参考 App（开启云端推送体验）
- `http://localhost:8080/portal` — 开发者门户

> `localhost` 是 Web Push 的白名单例外，本地即可体验推送；其它地址必须 HTTPS。

### 方式二：本地用 Docker 验证（验证镜像，无需域名）

```bash
docker build -f deploy/Dockerfile -t alarm-agent:local .
docker run -d --name alarm-local \
  -e ALARM_MASTER_KEY=$(openssl rand -hex 32) \
  -e PORT=8080 \
  -v $(pwd)/data:/app/data \
  -p 8080:8080 \
  alarm-agent:local
# 验证：curl http://localhost:8080/v1/health  → 200
docker rm -f alarm-local   # 用完清理
```

### 方式三：生产部署（公网 HTTPS）

详见 [`deploy/deploy.md`](deploy/deploy.md) 与 [`deploy/RELEASE_NOTES.md`](deploy/RELEASE_NOTES.md)。核心步骤：

```bash
cd deploy
cp .env.example .env && vi .env        # 填入 ALARM_MASTER_KEY（openssl rand -hex 32）
vi Caddyfile                           # 把域名改为你的真实域名（A 记录已指向本机）
docker compose up -d --build
docker compose exec app node manage_keys.js create --label prod --plan enterprise
```

---

## 🔌 开放 API

鉴权：所有 `/v1/*` 接口需 `Authorization: Bearer <你的KEY>`。完整契约见 [`openapi.yaml`](openapi.yaml)，人读说明见 [`api_reference.html`](api_reference.html)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 健康检查（返回 `version`） |
| POST | `/v1/parse` | 自然语言 → 结构化闹钟 JSON |
| GET | `/v1/usage` | 本 key 的套餐、用量与剩余配额 |
| GET/POST | `/v1/keys` | 密钥列表（脱敏）/ 创建 |
| POST | `/v1/keys/:key/disable` · `/enable` | 禁用 / 启用密钥（仅本租户） |
| POST/GET | `/v1/alarms` | 创建 / 列出托管闹钟（多租户隔离） |
| GET/PATCH/DELETE | `/v1/alarms/:id` | 查询 / 更新 / 删除单个闹钟 |
| GET/POST | `/v1/webhook` | 查询 / 配置租户级 Webhook 回调地址 |
| — | `/portal` | 开发者门户（浏览器） |

> 另有一组 `/api/*`（参考 App 用：浏览器 Web Push 订阅与闹钟），与开放平台隔离。

### 解析示例

```bash
curl -X POST http://localhost:8080/v1/parse \
  -H "Authorization: Bearer <你的KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text":"明天早上8点叫我起床"}'
```

```json
{
  "success": true,
  "raw": "明天早上8点叫我起床",
  "alarm": {
    "timestamp": 1760812800,
    "datetime": "2026-10-14T08:00:00+08:00",
    "date": "2026-10-14",
    "time": "08:00",
    "timezone": "Asia/Shanghai",
    "label": "叫我起床",
    "recurrence": null
  },
  "confidence": 0.9,
  "request_id": "req_01HX..."
}
```

`recurrence` 可能取值：`null`（单次）、`weekdays`（工作日）等。

### 创建托管闹钟 + 接收 Webhook

```bash
curl -X POST http://localhost:8080/v1/alarms \
  -H "Authorization: Bearer <你的KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text":"10秒后提醒我喝水","webhook_url":"https://你的接收地址"}'
```

闹钟到点后，平台向 `webhook_url` 投递：

```json
{
  "event": "alarm.fired",
  "alarm_id": "a1b2c3...",
  "tenant": "custom",
  "text": "10秒后提醒我喝水",
  "alarm": { "timestamp": 1760812800, "datetime": "...", "time": "08:00", "timezone": "Asia/Shanghai", "label": "提醒我喝水", "recurrence": null },
  "fired_at": "2026-10-13T08:00:10+08:00",
  "request_id": "req_..."
}
```

**验签**（请求头 `X-Alarm-Signature: sha256=<hex>`，对请求体原文做 HMAC-SHA256，密钥为你的 API Key 原始值）：

```js
const crypto = require('crypto');
const sig = 'sha256=' + crypto.createHmac('sha256', YOUR_RAW_KEY).update(rawBody).digest('hex');
const ok = sig === req.headers['x-alarm-signature'];
```

### 用量与配额

```bash
curl http://localhost:8080/v1/usage -H "Authorization: Bearer <你的KEY>"
```

月度解析配额用尽时，`POST /v1/parse` 返回 **HTTP 402 `quota_exceeded`**。

---

## 🔑 密钥与计费套餐

| 套餐 | 限流 | 月度解析配额 |
|---|---|---|
| `free` | 60 次/分钟 | 5,000 |
| `pro` | 600 次/分钟 | 100,000 |
| `enterprise` | 6,000 次/分钟 | 不限 |

- 创建密钥：`node manage_keys.js create --label dev --plan pro`（或门户内创建）。
- 原始 Key 仅在创建时返回一次，之后无法再查询明文。
- 计费为**软计费**（套餐配额/限速），当前版本未接入真实支付。

---

## 🛡️ 安全模型

- **密钥静态加密**：数据库仅存密钥的 **SHA-256 哈希**用于鉴权；原始 Key 以 **AES-256-GCM** 加密存储，主密钥来自环境变量 `ALARM_MASTER_KEY`。**生产必须设置 `ALARM_MASTER_KEY`，否则退化为明文并告警。**
- **Webhook 验签**：投递事件带 HMAC 签名，接收端可校验来源真实性。
- **租户隔离**：按 Key 的 `tenant` 字段隔离闹钟、用量、Webhook；禁用/启用密钥校验归属。
- **限流 + 配额**：按 key 限流、月度配额 402 拦截。

---

## 🧪 测试

```bash
node tests/run.js        # 解析引擎回归（56 例）
npm test                # 开放 API 集成测试（53 例，含密钥隔离、配额、Webhook 投递与验签、崩溃恢复）
```

集成测试使用独立 `test.alarm.db`，不会污染你的 `data/`。

CI（GitHub Actions）在每次 push/PR 到 `main` 时自动运行上述两组测试，并校验 Docker 镜像可构建（见 `.github/workflows/ci.yml`）。

---

## ⚠️ 已知限制（对外请如实告知）

1. **限流为内存态**：重启即清零、多实例不共享；单实例可用。
2. **软计费**：未接入真实支付。
3. **Webhook 为 best-effort**：长时间宕机会丢失个别触发；接收端请做幂等。
4. **SQLite 单文件**：中等规模足够，规模上来后换成 Postgres（见 `deploy.md`）。
5. **错过宽限 2 分钟**：触发点 ±2 分钟外的事件静默丢弃。

---

## 📁 项目结构

```
alarm_agent/
├── server.js            # HTTP 服务：开放 API + 参考 App + 推送/投递调度
├── db.js                # 持久层（node:sqlite）：密钥/闹钟/用量/Webhook 投递队列
├── nlu.js               # 自然语言 → 闹钟 JSON 解析引擎
├── manage_keys.js       # 密钥管理 CLI
├── portal.html          # 开发者门户（/portal）
├── index.html / sw.js   # 参考 App（Web Push）
├── openapi.yaml         # OpenAPI 3 契约（v1.0.0）
├── api_reference.html   # 人读 API 参考
├── LICENSE              # MIT License
├── tests/               # 解析引擎回归
├── test_openapi.js      # 开放 API 集成测试
├── deploy/              # Dockerfile / docker-compose.yml / Caddyfile / 部署与发布文档
└── data/                # 运行时数据（alarm.db、vapid.json、keys.json 遗留）
```

---

## 📄 许可证

本项目采用 **MIT License**，详见 [LICENSE](./LICENSE)。

可自由用于商业与非商业用途，唯一义务是在分发副本时保留版权与许可声明。
