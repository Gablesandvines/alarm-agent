# 闹钟 Agent — v1.0.0 发布说明

> 首个对外发布版本。定位：**中文自然语言的「定时能力平台」**——对外提供解析 API、多租户托管闹钟、Webhook 事件投递与开发者门户；最小化服务端，数据自托管。

---

## 一、这个版本能做什么

| 能力 | 说明 |
|---|---|
| 自然语言解析 | `POST /v1/parse` 把"明早 8 点叫我""周五下午 3 点半开会"等中文解析为结构化闹钟 JSON（规则引擎 + 可选 LLM 兜底） |
| 托管闹钟 | `POST /v1/alarms` 创建托管闹钟，服务端到点自动触发，无需你自建调度 |
| Webhook 投递 | 闹钟触发时向你的 `webhook_url` 投递 `alarm.fired` 事件，附带 HMAC-SHA256 签名，可验真伪 |
| 用量与配额 | `GET /v1/usage` 返回套餐、月度解析配额与剩余；超额返回 `402 quota_exceeded` |
| 密钥自助 | `GET/POST /v1/keys`、启/禁用，门户内即可管理本租户密钥 |
| 开发者门户 | `/portal` 单页控制台：用量看板、密钥管理、Webhook 配置 |
| 三档套餐 | `free`(60/min·5k 月) / `pro`(600/min·100k 月) / `enterprise`(6000/min·不限) |

---

## 二、发布前安全加固（本版本重点）

- **P0 · 密钥静态加密**：API Key 不再明文落库，数据库仅存 SHA-256 哈希用于鉴权；原始 Key 以 **AES-256-GCM** 加密存储，主密钥来自环境变量 `ALARM_MASTER_KEY`。明文仅在创建时返回一次。**生产必须设置 `ALARM_MASTER_KEY`，否则退化为明文并告警。**
- **P1 · Webhook 持久化投递队列**：闹钟触发只入队，独立投递 worker 按 `1→2→4→…→60s` 指数退避重试（最多 8 次，超限标记死信）。**进程崩溃/重启不会丢在途投递**，重启后自动续传 pending 行。

---

## 三、部署（自托管 Docker，生产推荐）

前置：服务器已装 Docker + Compose，且 80/443 入站开放，域名 A 记录指向本机公网 IP。

```bash
cd deploy
cp .env.example .env
# 编辑 .env，生成并填入 ALARM_MASTER_KEY：
#   openssl rand -hex 32
# 把 Caddyfile 里的 your-domain.example.com 改成你的域名
docker compose up -d --build
```

- Caddy 自动申请/续期 Let's Encrypt 证书，反向代理到应用容器（HTTPS 开箱即用）。
- 数据持久化挂载在 `../data`（SQLite + VAPID 密钥），重启不丢。
- 首次启动数据库为空时会自动生成一枚 `demo` 示例密钥；请用 `docker compose exec app node manage_keys.js create --label prod --plan enterprise` 创建你自己的密钥，并视情况禁用示例密钥。

详见同目录 `deploy.md`。

---

## 四、已知限制（请在对外说明中如实告知）

1. **限流为内存态**：重启即清零、多实例不共享。单实例可用；宣传的"X 次/分钟"在重启后短期内不生效。
2. **软计费**：当前仅做套餐配额/限速，**未接入真实支付**。可作为免费 + 等候名单运营。
3. **Webhook 为 best-effort**：长时间宕机可能丢失个别触发事件；接收端请做幂等处理。
4. **SQLite 单文件**：中等规模足够；规模上来后按 `deploy.md` 路线换 Postgres。
5. **错过宽限 2 分钟**：闹钟触发点 ±2 分钟外的事件静默丢弃（长期宕机场景）。

---

## 五、版本与迁移

- 协议/包版本统一为 **1.0.0**（此前内部迭代版本号不对外）。
- 从旧版（JSON 存储）升级：直接以新镜像启动即可，**首启自动迁移** `keys.json / alarms.json / usage.json / store.json` → `data/alarm.db`。若旧库为明文 Key 主键，会原地迁移为哈希 + 加密存储（`keys_old` 备份后删除）。
- 测试覆盖：引擎回归 56/56、集成测试 53/53（含密钥隔离、禁用非本租户→404、free 超额→402、Webhook 投递+验签、崩溃恢复续传）。

---

## 六、后续路线（未含在本版本）

- 限流持久化（Redis / DB 共享）
- 真实收费接入
- A 参考实现（iOS 原生壳 + 本地通知）
- 门户密码登录、密钥审计与轮转
