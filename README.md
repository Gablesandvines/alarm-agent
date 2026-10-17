# 闹钟 Agent

[![CI](https://github.com/Gablesandvines/alarm-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Gablesandvines/alarm-agent/actions/workflows/ci.yml)

> 中文自然语言的「定时能力平台」。把"明早 8 点叫我""周五下午 3 点半开会"这样的口语，解析成结构化闹钟；并进一步提供**托管闹钟 + 到点 Webhook 事件投递**，让你无需自建调度即可接入"定时触发业务"。最小化服务端、数据自托管。

---

## ✨ 特性

- **自然语言解析**：中文口语 → 结构化闹钟 JSON（规则引擎优先，可选 LLM 长尾兜底）。
- **托管闹钟**：服务端到点自动触发，无需你自己跑定时器。
- **时区与夏令时安全**：重复闹钟（每天 / 工作日 / 周末 / 每周 X / 每 N 天 / 双周 X / 每月 N 号）按闹钟时区计算下次触发，跨夏令时切换日墙钟时间不漂移。
- **时区真正可用化（解析触发脱离部署机时区）**：解析与触发不再绑死部署服务器的系统时区。调用方可显式传 `timezone`（IANA 名，如 `America/New_York`）；缺省时按 `请求 timezone → 租户 default_timezone → 环境变量 ALARM_DEFAULT_TZ_<tenant> → Asia/Shanghai` 回退。非法 IANA 名返回 `400 invalid_timezone`。同一句「明天 8 点」在纽约与上海会得到各自正确的墙钟与 UTC 时间戳。
- **中国法定节假日感知**：`工作日` 闹钟自动跳过元旦 / 春节 / 清明 / 劳动 / 端午 / 中秋 / 国庆等法定假期，并包含调休补班周末（数据随国务院办公厅每年放假通知更新，见 `scheduler.js` 的 `HOLIDAYS`）。
- **提前提醒（lead_minutes）**：单次与重复闹钟均支持「提前 N 分钟」触发——服务端重排已修正此前重复闹钟提前提醒失效的问题。
- **重复终止条件**：重复闹钟支持三种结束方式——「到某天为止」（含当天仍可触发）、「持续 N 天」、「共 N 次」。仅对重复闹钟生效，单次闹钟自动忽略；结束日期不污染闹钟自身锚点。解析结果落到 `alarm.end`（`{type:'date',date}` / `{type:'days',days}` / `{type:'count',count}`），前端与开放 API 均已打通（显示/编辑/持久化/到点终止）。
- **Webhook 投递**：触发时向你的回调地址投递 `alarm.fired` 事件，附带 **HMAC-SHA256 签名**，可验真伪。
- **多租户 API Key**：Bearer 鉴权、按 key 限流（计数持久化，重启不丢）、租户数据隔离。
- **可观测性**：结构化 JSON 日志 + `/v1/metrics` 指标（解析耗时、Webhook 投递成功率），便于接入日志 / 监控系统。
- **投递可靠性**：Webhook 投递队列 **原子抢占**（同一条不双发、可多实例共享）+ 5s 超时防挂起 + 卡死自动恢复 + 终态 7 天清理。
- **开发者门户**：`/portal` 单页控制台，自助管理密钥、配置 Webhook、查看用量看板。
- **前端单一数据源**：参考 App（`index.html`）直接引入 `nlu.js` 单文件引擎，不再内联复制解析逻辑——引擎升级（含多轮追问）前端自动同步，杜绝漂移。
- **对话式意图（取消 / 修改 / 查询）**：不只是"新建"。`nlu.js` 识别 `取消 / 删除`、`改成 / 改为`、`我有哪些 / 显示` 等口语，输出结构化 `intent`（`cancel` / `modify` / `query`）+ `match` / `update` 指令；参考 App 据此对本地闹钟列表执行取消、修改（时间 / 重复 / 备注 / 提前分钟）、查询并展示，真正像一个"对话式闹钟管家"。
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

> **生产加固清单**：除 `ALARM_MASTER_KEY` 外，还建议设置：
> - `ALARM_APP_KEY=<强随机串>` —— 启用 `/api/*` 接口鉴权（防绕过平台配额白嫖参考 App 接口）。
> - `ALARM_CORS_ORIGINS=https://你的前端域名` —— 收窄 CORS 可信来源。
> - `ALARM_MAX_BODY_BYTES=65536` —— 请求体上限（默认 64KB，已足够）。
> - `ALARM_DEFAULT_TZ_<tenant>` —— 为指定租户设置**服务端级默认时区**（IANA 名，如 `ALARM_DEFAULT_TZ_demo=America/New_York`）。当请求未带 `timezone` 且该租户密钥也未设 `default_timezone` 时生效，优先级高于全局兜底 `Asia/Shanghai`。常用于多租户部署中按地区预置默认时区。

---

## 🔌 开放 API

鉴权：所有 `/v1/*` 接口需 `Authorization: Bearer <你的KEY>`。完整契约见 [`openapi.yaml`](openapi.yaml)，人读说明见 [`api_reference.html`](api_reference.html)。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 健康检查（返回 `version`） |
| POST | `/v1/parse` | 自然语言 → 结构化闹钟 JSON |
| GET | `/v1/usage` | 本 key 的套餐、用量与剩余配额 |
| GET | `/v1/metrics` | 全局聚合指标：解析耗时、Webhook 投递成功率等 |
| GET/POST | `/v1/keys` | 密钥列表（脱敏）/ 创建 |
| POST | `/v1/keys/:key/disable` · `/enable` | 禁用 / 启用密钥（仅本租户） |
| POST/GET | `/v1/alarms` | 创建 / 列出托管闹钟（多租户隔离） |
| GET/PATCH/DELETE | `/v1/alarms/:id` | 查询 / 更新 / 删除单个闹钟 |
| GET/POST | `/v1/webhook` | 查询 / 配置租户级 Webhook 回调地址 |
| — | `/portal` | 开发者门户（浏览器） |

> 另有一组 `/api/*`（参考 App 用：浏览器 Web Push 订阅与闹钟），与开放平台隔离。

> **服务端重建 / 更换 VAPID 密钥后的自愈**：页面加载时会自动检测（校验服务端是否仍承认本地 clientId 的订阅 + 比对浏览器订阅绑定的 VAPID 公钥），不一致时自动换新订阅并重新注册，随后全量补同步本地闹钟，无需手动清理 Service Worker。

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

- 创建密钥：`node manage_keys.js create --label dev --plan pro --default-timezone America/New_York`（或门户内创建；`--default-timezone` 可省略，默认 `Asia/Shanghai`）。
- 原始 Key 仅在创建时返回一次，之后无法再查询明文。
- 计费为**软计费**（套餐配额/限速），当前版本未接入真实支付。

### 运行模式

服务端默认以**单用户模式**运行：开放 API 无需 API Key 即可直接调用（请求未携带 `Authorization` 时自动使用内置单用户身份），多租户平台能力（`/v1/keys` 密钥自助管理、计费套餐配额）休眠——相关接口返回 `404`，且不设月度解析配额。适合个人自用与本地演示。

需要多租户 SaaS 平台能力时，以平台模式启动：

```bash
ALARM_PLATFORM=1 node server.js
```

平台模式下所有 `/v1/*` 接口必须携带有效 API Key（否则 `401 missing_api_key`），`/v1/keys` 密钥自助管理与计费套餐（限流 / 月度配额）恢复可用；两种模式共用同一份数据，可随时切换。

---

## 🛡️ 安全模型

- **密钥静态加密**：数据库仅存密钥的 **SHA-256 哈希**用于鉴权；原始 Key 以 **AES-256-GCM** 加密存储，主密钥来自环境变量 `ALARM_MASTER_KEY`。**生产必须设置 `ALARM_MASTER_KEY`，否则退化为明文并告警。**
- **Webhook 验签**：投递事件带 HMAC 签名，接收端可校验来源真实性。
- **租户隔离**：按 Key 的 `tenant` 字段隔离闹钟、用量、Webhook；禁用/启用密钥校验归属。
- **限流 + 配额**：开放 API 按 key 限流、月度配额 402 拦截；参考 App 接口 `/api/parse` 另有独立的全局限流（防绕过平台配额白嫖）。
- **参考 App 接口（/api/*）可选项 App Key 鉴权**：设置环境变量 `ALARM_APP_KEY` 后，除公开端点 `/api/vapid` 外所有 `/api/*` 均需携带 `Authorization: Bearer <APP_KEY>` 或 `x-app-key` 请求头，否则 401；服务端会向同源首页注入该 Key，前端自动附带。**未设置时保持开放（仅适合本地演示，启动会告警）。**
- **请求体上限**：所有 POST 接口限制请求体大小（默认 64KB，可用 `ALARM_MAX_BODY_BYTES` 调整），超限返回 413，防止内存耗尽。
- **CORS 可配置**：默认 `*`；生产可通过 `ALARM_CORS_ORIGINS=https://a.com,https://b.com` 限定可信来源（仅列表内 Origin 放行，其余不带 `Access-Control-Allow-Origin`）。

---

## 🧪 测试

```bash
node tests/run.js        # 解析引擎回归（84 例，含多轮追问/矛盾检测/每月重复/对话式意图 cancel·modify·query/重复终止条件 date·days·count）
node tests/scheduler.js  # 调度/时区回归（38 例，含美东 DST 春进/秋退墙钟稳定、daily/monthly 重排、节假日感知工作日、提前提醒、重复终止条件 date·days·count 终止判定）
npm test                # 上述两套 + 开放 API 集成测试（69 例，含密钥隔离、配额、Webhook 投递与验签、崩溃恢复、原子抢占、指标边界、调度重排、提前提醒、投递退避、App Key 门控）
```

集成测试使用独立 `test.alarm.db`，不会污染你的 `data/`。

CI（GitHub Actions）在每次 push/PR 到 `main` 时自动运行上述两组测试，并校验 Docker 镜像可构建（见 `.github/workflows/ci.yml`）。

---

## ⚠️ 已知限制（对外请如实告知）

1. **限流已持久化**：限流计数写入本地 SQLite（随库多实例可共享，依赖 WAL）；真正水平扩展的多实例部署建议改用 Redis。
2. **软计费**：未接入真实支付。
3. **Webhook 为 best-effort 但已强化**：投递队列持久化 + 原子抢占（不双发）+ 崩溃恢复；接收端仍建议做幂等（同一 `alarm_id` 可能重投到终态前）。
4. **SQLite 单文件**：中等规模足够，规模上来后换成 Postgres（见 `deploy.md`）。
5. **错过宽限 2 分钟**：触发点 ±2 分钟外的事件静默丢弃。
6. **两套闹钟模型并存（设计如此，非冗余）**：参考 App（`legacy_alarms` + 浏览器 Web Push 订阅）服务于「关页也能响」的演示；开放平台（`alarms` + Webhook）服务于服务端业务触发。二者走**不同投递通道**（Web Push vs Webhook），仅触发计算（`computeNext`/`nextTriggerMs`）共享同一引擎（见 `scheduler.js`）。
7. **节假日数据为权威 2026 + 2027 预设**：2026 为国务院办公厅官方数据；2027 为「预设」（国务院通常于前一年 11-12 月公布，届时请以官方通知校准，尤其调休补班日）。更新只需改 `scheduler.js` 的 `HOLIDAYS`（或运行时调用 `setHolidays`）。

---

## 📁 项目结构

```
alarm_agent/
├── server.js            # HTTP 服务：开放 API + 参考 App + 推送/投递调度（薄编排层）
├── scheduler.js         # 时区感知调度（夏令时安全）：wallToEpoch/computeNext/nextTriggerMs
├── db.js                # 持久层（node:sqlite）：密钥/闹钟/用量/Webhook 投递队列
├── nlu.js               # 自然语言 → 闹钟 JSON 解析引擎
├── manage_keys.js       # 密钥管理 CLI
├── portal.html          # 开发者门户（/portal）
├── index.html / sw.js   # 参考 App（Web Push）
├── openapi.yaml         # OpenAPI 3 契约（v1.5.0）
├── api_reference.html   # 人读 API 参考
├── LICENSE              # MIT License
├── tests/               # 解析引擎回归 + 调度/时区回归
├── test_openapi.js      # 开放 API 集成测试
├── deploy/              # Dockerfile / docker-compose.yml / Caddyfile / 部署与发布文档
└── data/                # 运行时数据（alarm.db、vapid.json、keys.json 遗留）
```

---

## 📄 许可证

本项目采用 **MIT License**，详见 [LICENSE](./LICENSE)。

可自由用于商业与非商业用途，唯一义务是在分发副本时保留版权与许可声明。
