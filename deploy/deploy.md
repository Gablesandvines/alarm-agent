# 闹钟 Agent · 公网 HTTPS 部署指南

> 目标：让「关浏览器也响」在**真机/公网**可用。Web Push 要求页面在 **HTTPS**（或 localhost）下加载，因此生产环境必须有证书。本方案用 **Caddy 自动申请 Let's Encrypt 证书** + **Docker** 一键拉起，你只需准备域名与一台服务器。

---

## 一、前置条件
1. 一台有**公网 IP** 的服务器（云主机即可，1 核 1G 足够）。
2. 一个域名，并把 **A 记录**指向该服务器公网 IP。
3. 服务器入站放行 **80 与 443**（Caddy 申请证书需要 80）。
4. 服务器已安装 **Docker** 与 **Docker Compose**（v2）。

## 二、部署步骤
```bash
# 1) 把整个项目（含 deploy/ 目录）上传/克隆到服务器，例如 /opt/alarm-agent
# 2) 进入部署目录
cd /opt/alarm-agent/deploy

# 3) 准备生产环境变量（含密钥加密主密钥，切勿提交 .env）
cp .env.example .env
#   编辑 .env，生成并填入 ALARM_MASTER_KEY（≥32 位随机串）：
#     openssl rand -hex 32
vi .env

# 4) 修改 Caddyfile，把 your-domain.example.com 换成你的真实域名
vi Caddyfile

# 5) （可选）开启 LLM 长尾兜底：在 .env 中设置
#    ALARM_LLM_KEY / ALARM_LLM_BASE_URL / ALARM_LLM_MODEL

# 6) 构建并后台启动
docker compose up -d --build

# 6) 查看日志，确认无报错、证书申请成功
docker compose logs -f
```

## 三、使用
- 浏览器访问 `https://你的域名` → 点「开启云端推送」并授权通知。
- 设一个闹钟 → **关掉浏览器/标签页**，到点仍会收到系统推送通知。
- `data/` 目录（映射到宿主 `../data`）持久化订阅、闹钟、平台密钥与用量（`data/alarm.db` SQLite 数据库），以及 VAPID 密钥；升级代码后重跑 `docker compose up -d --build` 即可，数据不丢。开放平台还附带开发者控制台 `https://你的域名/portal`。

## 四、本地调试（无需域名/HTTPS）

### 方式 A：直接跑 Node（最简单）
```bash
# 在项目根目录
node server.js            # 默认 8080，可用 PORT=xxxx 改端口
# 浏览器打开 http://localhost:8080
# 注意：localhost 是 Web Push 的白名单例外，本地即可体验云端推送；
#       其它 HTTP 地址不行，必须 HTTPS（见上方生产方案）。
```

### 方式 B：用 Docker 本地起（验证镜像，无需域名/证书）
适合在 Windows/Mac 上先确认镜像能跑、密钥加密生效，再上生产。
```bash
# 1) 项目根目录构建镜像（Dockerfile 在 deploy/）
docker build -f deploy/Dockerfile -t alarm-agent:local .

# 2) 起容器：设主密钥、挂本地 data、映射端口
#    Git Bash 用 $(pwd)；PowerShell 改为 ${PWD} 或绝对路径如 /d/alarm_agent/data
docker run -d --name alarm-local \
  -e ALARM_MASTER_KEY=$(openssl rand -hex 32) \
  -e PORT=8080 \
  -v $(pwd)/data:/app/data \
  -p 8080:8080 \
  alarm-agent:local

# 3) 验证
curl http://localhost:8080/v1/health          # 期望 200，version 1.0.0
# 浏览器打开 http://localhost:8080/portal 粘贴密钥即可

# 4) 停止并清理
docker rm -f alarm-local
```
> 说明：localhost 是 Web Push 白名单例外，本地即可体验推送；生产环境仍必须 HTTPS（见第一~三节 Caddy 方案）。`data/` 挂载到宿主，闹钟/密钥不丢。

## 五、LLM 兜底（可选，按需开启）
默认**不调用 LLM**，规则引擎覆盖 ~80% 常见口语，零成本。
若想提升长尾/模糊口语的解析率，在 `docker-compose.yml` 的 `app.environment` 填入：
- `ALARM_LLM_KEY`：任意 OpenAI 兼容端点的 API Key
- `ALARM_LLM_BASE_URL`：兼容端点（如 `https://api.openai.com/v1` 或国内厂商）
- `ALARM_LLM_MODEL`：模型名（默认 `gpt-4o-mini`）

开启后逻辑：规则引擎置信度 ≥0.85 直接返回（不耗 LLM）；否则才调用 LLM；未配置 Key 时自动降级为规则结果，绝不崩溃。

## 五之一、生产安全：API Key 静态加密（强烈建议）
API Key 在数据库中**仅以 SHA-256 哈希做查找/鉴权**，原始 Key 落库时用 AES-256-GCM 加密，加密密钥来自环境变量 `ALARM_MASTER_KEY`：
- **生产必须设置** `ALARM_MASTER_KEY`（建议 ≥32 位随机串）。未设置时退化为明文存储并打印安全告警，仅适合本地开发。
- 原始 Key 仅在创建时返回一次（`manage_keys.js create` 或 `/v1/keys` 创建响应），之后无法再查询明文。
- 设置方式：在 `deploy/.env` 中填入 `ALARM_MASTER_KEY`（模板见 `.env.example`）；`docker-compose.yml` 已通过 `env_file: .env` 注入，**切勿把 `.env` 提交进仓库**（已被 `.gitignore` / `.dockerignore` 排除）。

## 六、注意事项
- **Webhook 投递语义**：托管闹钟触发后，投递事件进入**持久化队列**异步发送，失败按 1→2→4→8→16→32→60→60 秒指数退避、最多 8 次；进程崩溃/重启不会丢失在途投递（重启后由投递 worker 续传），属 best-effort。超出退避上限的个别事件标记为 `failed` 死信，建议接收端做好幂等。
- **服务端需常驻**：推送由 `server.js` 每秒调度经 Web Push 下发；容器 `restart: unless-stopped` 已保证进程挂掉自启。
- **移动端限制**：即便 HTTPS + Web Push，部分手机浏览器在应用被杀后仍可能限制后台推送（行业共性）；若要求「必响」，需进一步上原生壳（Capacitor/Tauri）。
- **证书续期**：Caddy 自动续期，无需人工干预。
- **停止/卸载**：在 `deploy/` 目录执行 `docker compose down`（数据卷保留）。

---

## 七、开放 API 与密钥管理（v1.0.0 已发布）

服务端对外暴露完整的开放平台能力，采用 **API Key（Bearer）** 鉴权、按 key 限流，与给网页用的内部 `/api/*` 隔离。端点一览（详见 `openapi.yaml`）：

- `GET /v1/health` 健康检查
- `POST /v1/parse` 自然语言 → 结构化闹钟 JSON
- `GET/POST /v1/keys` 与 `POST /v1/keys/:key/disable|enable` 密钥自助管理
- `POST/GET /v1/alarms` 与 `GET/PATCH/DELETE /v1/alarms/:id` 托管闹钟 CRUD（多租户隔离）
- `GET/POST /v1/webhook` Webhook 触发投递配置
- `GET /v1/usage` 用量与套餐统计

**持久层**：所有平台数据（密钥 / 闹钟 / 用量）统一存放于 **`data/alarm.db`（SQLite，由 Node 内置 `node:sqlite` 驱动，无需额外依赖）**。旧 `keys.json` 会在首次启动时自动迁移进库，迁移后 `keys.json` 成为遗留文件、不再被读取。

- **开发者门户（推荐）**：浏览器打开 `https://你的域名/portal`，粘贴任意有效 Key 即可自助管理密钥、配置 Webhook、查看用量看板。
- **首次启动**：若库为空，`server.js` 会自动生成一枚**示例 Key**（仅用于自托管快速体验，**切勿用于生产**），并打印到日志。
- **生产环境创建专属 Key**：务必通过容器执行（确保 `ALARM_MASTER_KEY` 生效、密钥被加密存储）：
  ```bash
  docker compose exec app node manage_keys.js create --label "生产-我的App" --plan enterprise
  docker compose exec app node manage_keys.js list
  ```
  其它命令：`disable <key>` / `enable <key>` 可禁用/启用某把密钥；`list` 查看全部（列出的是解密后的明文，便于你记录一次）。创建后建议禁用或忽略首次启动自动生成的 `demo` 示例密钥。
- **调用示例**：
  ```bash
  curl -X POST https://你的域名/v1/parse \
    -H "Authorization: Bearer <你的KEY>" \
    -H "Content-Type: application/json" \
    -d '{"text":"明天早上8点叫我起床"}'
  ```
- **接口契约**：完整请求/响应 schema 见仓库根 `openapi.yaml`（可直接导入 Swagger UI / Postman 生成文档与 SDK）；人读说明见 `api_reference.html`。

---

## 八、真机/公网实测清单（验证"关浏览器也响"）

> 构建环境内可验证**服务端逻辑与镜像可构建**，但**手机锁屏接收推送**必须由你在真机完成。下方分两部分。

### A. 服务端侧（Agent 已验证 / 可验证）
- [x] `docker compose build` 镜像构建成功（web-push 依赖安装、`node:sqlite` 在 `node:22-alpine` 可用、代码与 `data` 卷挂载正确）
- [x] 容器内 `/v1/health` 返回 200（version 1.0.0）、`/v1/parse` 带 Key 鉴权返回正确解析；设置 `ALARM_MASTER_KEY` 后新建密钥的 `key_enc` 为 AES 加密（非 `raw:` 明文），密钥静态加密已验证
- [ ] 浏览器访问 `https://域名` → DevTools → Application → Service Workers 显示已注册且状态 active
- [ ] 点「开启云端推送」授权通知后，服务端日志出现 `新订阅 <id>`

### B. 真机侧（需你执行）
- [ ] 用**手机浏览器**（iOS Safari / Android Chrome）打开 `https://域名`（必须是真实公网 HTTPS 域名；localhost 例外不适用手机）
- [ ] 授权通知权限，设一个 **1 分钟后**的闹钟
- [ ] **完全关闭浏览器 / 锁屏**，等待闹钟时间
- [ ] 验证：锁屏或后台仍弹出**系统推送通知**（而非仅应用内响铃）
- [ ] 若收不到：检查手机系统通知开关、浏览器是否允许后台推送

### 平台差异（重要）
- **Android Chrome**：后台推送限制较少，基本可用。
- **iOS Safari**：Web Push 仅在**已"添加到主屏"的 PWA** 且系统通知开启时可用；未添加主屏或系统通知关闭则收不到。
- 若业务对"必响"有强诉求，仍是项 6 **原生壳（Capacitor/Tauri）** 更稳，但成本更高。

---

## 九、服务端侧验证记录（本次）
- `docker compose build`：镜像可构建（`node:22-alpine` 内置 `node:sqlite` 可用、web-push 依赖安装、代码与 `data` 卷挂载正确）。
- 容器内冒烟：`/v1/health`=200（version 1.0.0）、`/v1/parse` 带 Key 鉴权 200 且命中解析；`ALARM_MASTER_KEY` 生效下新建密钥 `key_enc` 为 AES 加密（已验证非明文）。
- 本地 HTTP 全链路已通过自动化测试 `test_openapi.js`（health / 鉴权 / 解析 / 限流 / 模糊澄清 / now 覆盖 / 闹钟 CRUD / 租户隔离 / Webhook 投递与验签 / 用量 / 门户 / 密钥管理 / 套餐配额 / 崩溃恢复，53/53 通过）。HTTPS 真机链路见第八节 B 项。
