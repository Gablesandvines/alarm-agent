# 第二阶段第一批（F3 / F6 / I3）增量架构设计

> 基线：`9e84b63`（第一阶段「先稳」已合并，301 断言全绿）。
> 约束：零新增依赖 · 原生前端 · 最小变更 · 本地优先 · 不破坏 phase1 推送三不变量（`syncedIds` / `resyncAllToServer` / `healPushRegistration`）。
> 本文所有行号基于 `9e84b63` 现状，实现时以「锚点代码」为准（行号可能因上下文微调）。

---

## 0. 现状锚点（已核对真实行号）

| 文件 | 关键位置 | 作用 |
|---|---|---|
| `index.html` | `saveAlarm` L514–527 | 新建保存入口，`syncAlarmToServer('add',item)` |
| `index.html` | `commitEdit` L378–404 | 内联编辑保存 |
| `index.html` | `applyIntentMatch` modify L426–443 | 对话式修改 |
| `index.html` | `fire(a)` L584–594 | 触发：响铃+弹窗+非重复/次数终止置 enabled=false |
| `index.html` | `ringSnooze.onclick` **L596** | **现状 bug：按 time 文本找原闹钟并把它改成单次** |
| `index.html` | `tick` L598–599 | 每秒扫描 `enabled` 闹钟触发 |
| `index.html` | `notify` L576–583 | `if(pushActive && syncedIds.has(a.id)) return;` 让位 SW |
| `index.html` | `syncAlarmToServer` L698–710（payload L702） | add/remove 同步（**未带 kind/parentId**） |
| `index.html` | `renderList` L315–341（`$('cnt')` L316） | 主列表渲染 |
| `index.html` | `del` L529 | 删除 |
| `server.js` | `/api/alarm` L584–600（构造 L589–596，save L597） | legacy 落库，`INSERT OR REPLACE`，强制 `fired:false`、`nextTrigger=ts*1000` |
| `server.js` | `/api/alarm/update` L606–613 | F1 启停 |
| `server.js` | 火循环 legacy L665–709；missed 分支 L669–676；dedup+投递 L678–696；推进 L697–708 | Web Push |
| `server.js` | platform 循环 L711–736 | 状态推进 + Webhook |
| `server.js` | App Key 门控 L560–565 | `/api/*` 鉴权 |
| `server.js` | 清理定时器 L259–261 | prune 范式参考 |
| `db.js` | 建表块 L72–150；`legacy_alarms` L124–139 | `CREATE TABLE IF NOT EXISTS` |
| `db.js` | `listLegacyAlarms` L315–324；`saveLegacyAlarm` L325–332；`pruneDeliveries` L368–371；exports L561–570 | 读写/清理/导出范式 |
| `scheduler.js` | `computeNext` L128；`nextTriggerMs` L88；`wallClockAt` L186；`tzDateParts` L34；`wallToEpoch` L24；exports L193–196 | 唯一时间换算来源（**复用，禁另造**） |
| `tests/run.js` | L206–220 | phase1 聚合范式（require 子套件累加 pass/fail） |
| `tests/phase1.js` | 全文 | 子进程 server + `node:sqlite` 读库 + `extractFn` 源码断言范式 |

---

## 1. F3 —— 贪睡服务端化（P0）

### 1.1 数据模型：瞬态贪睡条目（不改原闹钟）
新建瞬态条目字段（前端内存 `alarms[]` + 落库 `legacy_alarms`）：

| 字段 | 值 |
|---|---|
| `id` | `'snz_' + 原id`（贪睡再贪睡**复用同 id**，不堆积） |
| `timestamp` | `Math.floor((Date.now()+9*60000)/1000)` |
| `time` | 该刻**墙钟**（用 `Scheduler.wallClockAt(targetMs, tz)`，tz=继承） |
| `date` | `Scheduler.tzDateParts(targetMs, tz)` 拼 `YYYY-MM-DD` |
| `recurrence` | `'none'` |
| `timezone` | 继承原闹钟（缺省 `getUserTz()`） |
| `label` | 继承原闹钟 |
| `lead_minutes` | `0` |
| `end` | `null` |
| `enabled` | `true` |
| `kind` | `'snooze'` |
| `parentId` | 原闹钟 id |
| `createdAt` | `Date.now()` |

**硬性：绝不修改原闹钟的任何字段。**

### 1.2 前端改动（`index.html`）
1. **新增全局 `let ringingId = null;`**，在 `fire(a)`（L584）首行 `ringingId = a.id;`（替代原「按 time 文本找闹钟」的脆弱方式）。
2. **重写 `ringSnooze.onclick`（L596）**：
   ```
   $('ringSnooze').onclick=()=>{
     const rid = ringingId;                      // 先捕获，后清空
     $('ringbox').classList.remove('show');
     if(!rid) return;
     const base = alarms.find(x=>x.id===rid);
     const parentId = rid.indexOf('snz_')===0 ? rid.slice(4) : rid;   // 贪睡再贪睡：父级归一
     const sid = 'snz_' + parentId;                                   // 复用同 id → 不堆积
     const tz = (base && base.timezone) || getUserTz();
     const targetMs = Date.now() + 9*60000;
     const parts = (typeof Scheduler!=='undefined' && Scheduler.tzDateParts)
       ? Scheduler.tzDateParts(targetMs, tz) : { y:new Date(targetMs).getFullYear(), mo:new Date(targetMs).getMonth()+1, d:new Date(targetMs).getDate() };
     const hm = (typeof Scheduler!=='undefined' && Scheduler.wallClockAt)
       ? Scheduler.wallClockAt(targetMs, tz) : `${pad(new Date(targetMs).getHours())}:${pad(new Date(targetMs).getMinutes())}`;
     const existing = alarms.find(x=>x.id===sid);
     const snooze = existing || { id:sid };
     Object.assign(snooze, {
       raw: base && base.raw, timestamp: Math.floor(targetMs/1000),
       datetime:null, date:`${parts.y}-${pad(parts.mo)}-${pad(parts.d)}`,
       time: hm, recurrence:'none', timezone: tz,
       label: (base && base.label) || '', lead_minutes:0, end:null, fired_count:0,
       enabled:true, kind:'snooze', parentId, createdAt: Date.now()
     });
     if(!existing) alarms.push(snooze);          // 进 alarms[] 供本地 tick() 触发
     save(); renderList();
     toast('已贪睡 9 分钟');
     snoozeToServer(snooze);                     // 落库 + fire_log(snooze) + 离线队列
   };
   ```
3. **瞬态条目的生命周期工具**（新增）：
   - `isTransient = a => a && typeof a.id==='string' && a.id.indexOf('snz_')===0;`
   - `renderList`（L315）：`alarms.forEach` 内首行 `if(isTransient(a)) return;`（**不进主列表**）；`$('cnt')` 改为真实闹钟数 `alarms.filter(a=>!isTransient(a)).length`。
   - `pruneTransients()`：移除 `isTransient(a) && (!a.enabled || a.timestamp*1000 < Date.now()-120000)` 的条目；每条被移除时 `syncAlarmToServer('remove', a)`（best-effort，删服务端行 + 出 syncedIds）。**调用点**：`load()`（L187 后）、`ringStop.onclick`（L595 处理完再 prune）、`del` 级联。
   - `removeSnooze(origId)`：`const sid='snz_'+origId; const sn=alarms.find(x=>x.id===sid); if(sn){ alarms=alarms.filter(x=>x.id!==sid); syncAlarmToServer('remove',sn); }`。
4. **级联删除**：`del(id)`（L529）在移除原闹钟后调用 `removeSnooze(id)`。
5. **`syncAlarmToServer('add')` payload（L702）补字段**：`..., kind:item.kind||undefined, parentId:item.parentId||undefined`。普通闹钟 `kind` 缺省 → 服务端不写 snooze 日志。
6. **离线队列 `alarm_agent_pending_snooze`（产品决策）**：`snoozeToServer(item)`：在线且 `clientId` 才 `syncAlarmToServer('add',item)`；离线入队（`{item}`），`window` 已有 `online` 监听追加 `flushSnoozeQueue`。**失败不销毁式回滚**：保留本地定时 + `toast('贪睡已本地生效，联网后同步')` + 入队重试；不取消本地响铃。

### 1.3 服务端改动（`server.js` `/api/alarm` L584–600）
- 读取 `body.kind`、`body.parentId`；`alarm` 增加 `kind: body.kind || null`（仅用于日志区分，`saveLegacyAlarm` 不强制存 kind——见 §1.4 决策）。
- `saveLegacyAlarm(alarm)` 之后：
  ```
  if (body.kind === 'snooze') {
    db.logFire({ alarm_id: body.parentId || (body.id||'').replace(/^snz_/,''),
                 client_id: body.clientId, kind:'snooze',
                 label: alarm.label, time: body.time, timezone: tz, fired_at: Date.now() });
  }
  ```

### 1.4 瞬态条目与本地 `alarms[]` / 推送门控的状态机（技术风险 #1 —— 明确条件）
**生命周期状态机**

| 状态 | 触发 | 本地 `alarms[]` | `enabled` | `syncedIds` |
|---|---|---|---|---|
| S0 创建 | 点「再睡9分钟」 | push `snz_x` | true | 在线+push → `add` 成功则 **入**；离线/无push → **不入** |
| S1 待响 | `tick()` 每秒 | 保持 | true | 保持 |
| S2 响铃 | `computeNextTrigger` 返回 ts≤now → `fire()` | 保持 | `recurrence='none'` → `fire()` 置 **false** | 保持 |
| S3 处置 | 用户 Stop / 再贪睡 | Stop→`pruneTransients` 移除；再贪睡→S0 复用同 id | — | 被移除时 `remove` → **出** |
| S4 清理 | `load()` / Stop / 级联 | 移除过期或已停用 | — | 出 |

**与推送门控的交互（`notify` L576）**
- 关键判断仍是 `if(pushActive && syncedIds.has(a.id)) return;`（**不改**）。
- `snz_` 条目**何时进 syncedIds**：仅当 `pushActive && clientId && 在线` 且 `POST /api/alarm` 成功（复用现有 `syncAlarmToServer('add')` 内的 `syncedIds.add`）。
- **离线本地兜底必响**：离线/无 push ⇒ `add` 失败 ⇒ `syncedIds` 不含该 id ⇒ `notify` 不走 return ⇒ 本地 `new Notification` 必响。**与 phase1 语义完全一致**。
- **不破坏三不变量**：`snz_` 的进出仅通过现有 `syncAlarmToServer`／`resyncAllToServer`（它遍历 `enabled` 闹钟，会顺带补同步 `snz_`）／`healPushRegistration`（不感知 snz）。三者逻辑一行不改；回归断言其仍在且行为不变。

---

## 2. F6 —— 今日/历史视图（F6a 后端先行）

### 2.1 新表 `fire_log`（`db.js` 建表块 L72–150 内追加，`IF NOT EXISTS` 天然幂等）
```sql
CREATE TABLE IF NOT EXISTS fire_log (
  id TEXT PRIMARY KEY,
  alarm_id TEXT,
  client_id TEXT,
  tenant TEXT,
  kind TEXT NOT NULL,        -- ring | snooze | missed
  label TEXT,
  time TEXT,
  timezone TEXT,
  fired_at INTEGER NOT NULL  -- epoch ms，便于 [from,to) 范围与排序
);
CREATE INDEX IF NOT EXISTS idx_fire_log_fired_at ON fire_log(fired_at);
CREATE INDEX IF NOT EXISTS idx_fire_log_client ON fire_log(client_id, fired_at);
```

### 2.2 `db.js` 新增函数（并在 exports L561–570 登记）
```js
function logFire({alarm_id,client_id,tenant,kind,label,time,timezone,fired_at}) {
  const id='fl_'+crypto.randomBytes(9).toString('hex');
  db.prepare('INSERT INTO fire_log (id,alarm_id,client_id,tenant,kind,label,time,timezone,fired_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, alarm_id||null, client_id||null, tenant||null, kind, label||'', time||null, timezone||null, fired_at||Date.now());
  return id;
}
function listFireLog({clientId, from, to, limit}) {
  let sql='SELECT * FROM fire_log WHERE client_id = ?'; const params=[clientId];
  if(from!=null){ sql+=' AND fired_at >= ?'; params.push(from); }
  if(to!=null){ sql+=' AND fired_at < ?'; params.push(to); }   // 半开区间 [from,to)
  sql+=' ORDER BY fired_at ASC';
  if(limit){ sql+=' LIMIT ?'; params.push(limit); }
  return db.prepare(sql).all(...params).map(r=>({id:r.id,alarm_id:r.alarm_id,client_id:r.client_id,tenant:r.tenant,kind:r.kind,label:r.label,time:r.time,timezone:r.timezone,fired_at:r.fired_at}));
}
function pruneFireLog(beforeMs){ return db.prepare('DELETE FROM fire_log WHERE fired_at < ?').run(beforeMs).changes; }
```

### 2.3 火循环写点（`server.js`，技术风险 #3 —— 互斥与对齐）
> 互斥保证：legacy 循环中「错过分支」以 `continue`（L676）结束，**永远到不了**下述 ring 写点，故同一 tick 同一闹钟「missed 与 ring 天然互斥」。

1. **missed（错过分支 L669–676）**：在 `db.saveLegacyAlarm(a); continue;`（L676）**之前**插入：
   ```js
   db.logFire({ alarm_id:a.id, client_id:a.clientId, kind:'missed', label:a.label, time:a.time, timezone:tz, fired_at:now });
   ```
2. **ring（投递块 `if(!dup){…}` L683–696 内，订阅 if/else 之后、推进之前）**：
   ```js
   db.logFire({ alarm_id:a.id, client_id:a.clientId, kind:'ring', label:a.label, time:a.time, timezone:tz, fired_at:now });
   ```
   位于 `if(!dup)` 内 → 与 dedup 对齐；同时覆盖「有订阅推送」和「无订阅（审计应响）」两种分支；`snz_` 行触发的也是这里（`alarm_id` 形如 `snz_xxx`，供前端识别「贪睡响铃」）。
3. **platform ring（`if(!dup){...}` L721–723 内，`enqueueWebhookDelivery` 之后）**：
   ```js
   db.logFire({ alarm_id:a.id, tenant:a.tenant, kind:'ring', label:al.label, time:al.time, timezone:al.timezone, fired_at:now });
   ```
   与 enqueue/推进对齐；platform 行 `client_id` 为空，不进 App 今日视图，仅作审计/未来按 tenant 查询。

### 2.4 `GET /api/firelog` 端点（技术风险 #4 —— 鉴权口径）
插入 `handleApi`（L613 之后、`/api/parse` L614 之前）：
```js
if (url === '/api/firelog' && req.method === 'GET') {
  const q = new URL(req.url, 'http://localhost').searchParams;
  const clientId = (q.get('clientId')||'').trim();
  if (!clientId) return appError(res, 'bad_request', 'missing clientId', 400);
  const parseMs = v => { if(v==null||v==='') return null; const n=Number(v); if(isFinite(n)) return n; const d=Date.parse(v); return isNaN(d)?null:d; };
  const from = parseMs(q.get('from')), to = parseMs(q.get('to'));
  const logs = db.listFireLog({ clientId, from, to, limit: 500 });
  return sendJSON(res, { clientId, count: logs.length, logs });
}
```
口径：
- **鉴权**：完全沿用 L560–565 App Key 门控（`APP_API_KEY` 设置时缺/错 key → 门控统一 401 `unauthorized`；单用户默认开放）。**端点内不重复鉴权、不返回 403**。
- **clientId 必填**：缺失/空 → 400 `bad_request`（防越权读取他人：始终 `WHERE client_id = ?`）。
- **from/to** 可选（客户端按用户时区算好传 epoch ms）；缺省不限制范围（配合 `limit:500` 兜底）；区间半开 `[from,to)`。

### 2.5 保留期清理（`server.js` L259–261 附近）
```js
const FIRELOG_RETENTION_MS = (Number(process.env.ALARM_FIRELOG_RETENTION_DAYS) || 30) * 86400000;
setInterval(() => { try { const n = db.pruneFireLog(Date.now() - FIRELOG_RETENTION_MS); if(n>0) log('info','firelog_pruned',{count:n}); } catch(e){} }, 6*3600*1000);
```

### 2.6 fire_log「贪睡重复计数」精确规则（技术风险 #2 —— 可测）
一次完整「响铃→贪睡→再响」产生（push 在线时）：

| 事件 | 写入 | `kind` | `alarm_id` | 今日视图展示 | 计数归属 |
|---|---|---|---|---|---|
| 原闹钟响（server 投递/应响） | legacy ring 写点 | `ring` | 原 id | 「响铃 08:00」 | 真实响铃 +1 |
| 点贪睡（创建） | `/api/alarm kind=snooze` | `snooze` | **原 id**（parentId） | 「贪睡 → 08:09」 | **贪睡 +1** |
| snz 到点响 | legacy ring 写点（`snz_` 行） | `ring` | **`snz_原id`** | 「贪睡响铃 08:09」 | 单列，「贪睡响铃」徽标 |

**计数定义（前端）**：
- `snoozeCount` = `kind==='snooze'` 的行数（**每次贪睡动作计 1**）。
- `ringCount`（真实响铃）= `kind==='ring' && alarm_id` 不以 `snz_` 开头 的行数。
- `snoozeRing`(贪睡响铃) = `kind==='ring' && alarm_id` 以 `snz_` 开头 的行，**只在时间线展示，不重复计入 snoozeCount、也不计入真实 ringCount**。
- 效果：既「贪睡计 1 次」，又「体现贪睡后那声铃」且不重复。

**可测验收**：构造「POST 原闹钟 → POST snz(kind=snooze) → 等 snz 触发」，断言库中恰好：1 行 `snooze`(alarm_id=原)、1 行 `ring`(alarm_id=`snz_原`)；对 `/api/firelog` 返回做前端同口径计数 → `snoozeCount===1` 且 `snoozeRing===1` 且 `ringCount===0`（本例原闹钟本身未在服务器响，仅本地触发）。

### 2.7 F6b 前端视图（`index.html`，F6a 之后）
- 新增卡片（「我的闹钟」卡 L158–161 之后）：`#dayPrev / #dayLabel / #dayNext / #todayList / #nextAgg / #todayStatus`。
- `renderToday()`：`tz=getUserTz()`；`from=Scheduler.wallToEpoch(y,mo,d,0,0,tz)`、`to=下一天0点`；`fetch('/api/firelog?clientId=...&from=..&to=..')`；按 `kind` 渲染徽标（`ring/snooze/missed` + `snz_` 前缀→「贪睡响铃」）。
- **下次触发聚合**：`alarms.filter(启用且非瞬态).map(computeNextTrigger).filter(非空).sort` 取最近 3 条。
- **离线只读提示**：`!navigator.onLine` 或 fetch 失败 → `#todayStatus` 显示「离线：历史记录需联网查看（仅展示本地下次触发）」，仍渲染聚合。
- 触发时机：`load` 后、`fire` 后、贪睡/删除后。

---

## 3. I3 —— 规则式冲突检测（前端，非阻塞）

### 3.1 采样与判冲突（复用 `Scheduler.computeNext`，禁另造换算）
```js
const CONF_HORIZON_MS = 90*86400000, CONF_MAX_N = 60, CONF_EPS_MS = 60000, CONF_MAX_ALARMS = 200;
function sampleOccurrences(a) {
  const out = [];
  if (typeof Scheduler==='undefined' || !Scheduler.computeNext) return out;   // 技术风险 #5：降级静默
  const tz = a.timezone || 'Asia/Shanghai';
  const now = Date.now();
  if (a.recurrence==='none') { if(a.timestamp){ const t=a.timestamp*1000; if(t>=now) out.push(t); } return out; }
  const anchor = (a.timestamp || Math.floor(now/1000))*1000;
  let cursor = now;
  for (let i=0;i<CONF_MAX_N;i++){
    let t; try { t = Scheduler.computeNext(a.time, a.recurrence, anchor, tz, cursor); } catch(e){ break; }
    if (t==null || t>now+CONF_HORIZON_MS) break;
    out.push(t); cursor = t+1;
  }
  return out;
}
function detectConflicts(candidate, excludeId) {
  try {
    if (typeof Scheduler==='undefined') return [];                              // 降级
    const cand = sampleOccurrences(candidate); if(!cand.length) return [];
    const pool = alarms.filter(a=>!isTransient(a) && a.enabled && a.id!==excludeId && a.id!==candidate.id);
    const list = pool.slice(0, CONF_MAX_ALARMS);                                // 性能兜底
    const res = [];
    for (const a of list) {
      const smp = sampleOccurrences(a);
      let min = Infinity;
      for (const t1 of cand) for (const t2 of smp) { const d=Math.abs(t1-t2); if(d<min) min=d; }
      if (min <= CONF_EPS_MS) res.push({ id:a.id, label:a.label||a.time, minDiffMs:min });
    }
    return res;
  } catch(e){ return []; }                                                       // 任何异常静默
}
function checkConflict(candidate, excludeId) {
  try { const c = detectConflicts(candidate, excludeId); if(c.length) toast('⚠️ 与「'+c[0].label+'」时间相近（<1分钟），已照常保存'); } catch(e){}
}
```
- 判据：`|t1-t2| <= 60s`；跨时区/DST 以 **epoch** 直接比较（天然正确）。
- 采样：仅对启用、非瞬态、非自身闹钟；每个最多 60 次 / 90 天；全局最多扫 200 个闹钟；纯同步、无网络、无 LLM。

### 3.2 调用点（非阻塞——只在保存后提示，绝不 return / 拦截）
- `saveAlarm`（L514–527）：`alarms.unshift(item); save(); renderList();` 之后 → `checkConflict(item, item.id)`。
- `commitEdit`（L378–404）：`save(); editingId=null; renderList();` 之后 → `checkConflict(a, a.id)`。
- `applyIntentMatch` modify（L426–443）：每个 `matched` 修改并 `save()` 后 → `checkConflict(a, a.id)`。
- **技术风险 #5 降级**：`window.Scheduler` 缺失（旧缓存/node 环境）→ `detectConflicts` 顶部 `typeof Scheduler==='undefined'` 直接返回 `[]`，无异常、无阻塞；采样有 `CONF_MAX_N/CONF_MAX_ALARMS/异常 try-catch` 性能与健壮兜底。

---

## 4. 数据/接口变更汇总
| 变更 | 位置 | 说明 |
|---|---|---|
| 新表 `fire_log`（+2 索引） | db.js 建表块 | `IF NOT EXISTS` 幂等，无需 ALTER |
| `logFire/listFireLog/pruneFireLog` | db.js + exports | 写/查/清理 |
| `/api/alarm` 新增可选 `kind`/`parentId` | server.js L584–600 | kind=snooze 时写 `snooze` fire_log |
| 火循环 3 写点（missed/ring/platform-ring） | server.js L669–736 | 技术风险 #3 互斥与对齐 |
| `GET /api/firelog?clientId&from&to` | server.js handleApi | 半开区间 `[from,to)`，App Key 门控 |
| `pruneFireLog` 定时器（30 天，可 ENV 覆盖） | server.js L259 附近 | 防膨胀 |
| `syncAlarmToServer` payload + `kind/parentId` | index.html L702 | 普通闹钟不带 kind |
| 瞬态贪睡条目 + `ringingId` + 队列 | index.html | 不改原闹钟 |
| `detectConflicts/checkConflict` | index.html | 规则式、非阻塞 |

---

## 5. 有序任务清单（F6a 后端先行）

> 顺序：**T1 → T2（F6a 后端先行）** 完成并回归后，前端 T3/T4/T5 并行，最后 T6 收口。

### T1 〔F6a·后端·P0〕fire_log 表 + 存取清理
- 文件/行号：`db.js` 建表块 L72–150（追加 `fire_log` + 索引）、新增 `logFire/listFireLog/pruneFireLog`、exports L561–570。
- 依赖：无。
- 验收：① 启动后 `PRAGMA table_info(fire_log)` 含 9 列；② `logFire` 插入→`listFireLog` 可读且按 `fired_at` 升序；③ `listFireLog {from,to}` 半开区间（`fired_at==to` 的行被排除）；④ `pruneFireLog(now)` 删除旧行、保留新行；⑤ 301 断言保持全绿。

### T2 〔F6a·后端·P0〕火循环写点 + /api/firelog + 清理定时器 + snooze 日志
- 文件/行号：`server.js` L584–600（kind=snooze 写 logFire）、missed 分支 L676 前、ring 写点 L683–696 内、platform L721–723 内、`GET /api/firelog`（L613 后）、清理定时器 L259 附近。
- 依赖：T1。
- 验收：① enabled 到期 legacy 触发 → 恰 1 行 `ring`（有/无订阅均写）；② 错过（超过 MISS_GRACE）→ 恰 1 行 `missed` 且**无 ring**（互斥）；③ `POST /api/alarm kind=snooze` → 1 行 `snooze`（alarm_id=parentId）；④ `snz_` 到期触发 → `ring` 且 `alarm_id` 以 `snz_` 开头；⑤ platform 到期 → `ring`（tenant 有值、client_id 空）；⑥ `GET /api/firelog` 缺 clientId→400、正常→升序、`[from,to)` 正确；⑦ 301 断言全绿。

### T3 〔F3·前端·P0〕瞬态贪睡服务端化 + 生命周期 + 级联 + 离线队列
- 文件/行号：`index.html` L596（重写）、`fire` L584（记 ringingId）、`renderList` L315/L316（过滤瞬态）、`del` L529（级联）、`load`/`ringStop`（prune）、`syncAlarmToServer` payload L702（kind/parentId）、新增 `isTransient/pruneTransients/removeSnooze/snoozeToServer/flushSnoozeQueue` + `online` 监听。
- 依赖：T2（服务端需识别 kind=snooze 并落 fire_log）。
- 验收（行为）：① 贪睡生成 `snz_原id`、`recurrence='none'`、`timestamp=+9min`、不进主列表；② **原闹钟字段零改动**（前后快照相等）；③ 再贪睡复用同 `snz_` id、`alarms` 中该 id 唯一；④ 离线贪睡：本地 9 分钟必响（`notify` 未被 `syncedIds` 让位）+ `alarm_agent_pending_snooze` 入队，联网后冲刷；⑤ 删除原闹钟级联删除 `snz_`（本地 + `/api/alarm/remove`）；⑥ `syncedIds/resyncAllToServer/healPushRegistration` 三不变量未被破坏（源码断言仍存在且 toggle 未引用）。

### T4 〔I3·前端·P1〕规则式冲突检测（非阻塞 + 降级）
- 文件/行号：`index.html` 新增 `sampleOccurrences/detectConflicts/checkConflict` + 常量；调用点 `saveAlarm` L524 后、`commitEdit` L401 后、modify L442 后。
- 依赖：无（纯前端，复用 `Scheduler.computeNext`）。
- 验收：① `|t1-t2|<=60s` 判冲突并 toast，**仍照常保存**（不 return）；② `typeof Scheduler==='undefined'` 时 `detectConflicts` 返回 `[]` 不抛错；③ 采样上限 60 次/90 天、扫表上限 200、异常 try-catch；④ 排除自身 id 与瞬态；⑤ 源码断言函数与守卫存在。

### T5 〔F6b·前端·P1〕今日/历史视图 + 下次触发聚合 + 离线只读
- 文件/行号：`index.html` 新增卡 + `renderToday/nav`；按 §2.6 计数口径渲染；`load`/`fire`/贪睡/删除后刷新。
- 依赖：T2（端点）、T3（贪睡条目展示）。
- 验收：① 按用户时区算 `from/to` 拉取并按 `fired_at` 升序渲染；② `kind` 徽标正确（含 `snz_`→「贪睡响铃」）；③ 计数=snoozeCount 计 1 次、snoozeRing 单列不重复；④ 下次触发聚合展示最近 N；⑤ 离线显示只读提示且聚合仍可用。

### T6 〔测试·P1〕tests/phase2.js 接入 run.js
- 文件/行号：新建 `tests/phase2.js`（仿 `tests/phase1.js`：子进程 server + `node:sqlite` + `extractFn`），`tests/run.js` L206–220 追加 `phase2` 聚合块。
- 依赖：T1–T5。
- 验收：见 §6；`node tests/run.js` 后原 301 断言 + 新增断言全绿，退出码 0。

---

## 6. 新增测试建议（`tests/phase2.js`）
> 完全复用 phase1 子进程 + 读库 + `extractFn` 范式（独立测试库 `phase2.alarm.db`、独立端口如 8097）。

**F3（服务端 + 源码）**
- `POST /api/alarm kind=snooze(id=snz_x,parentId=x,time) → 200`；库中 `fire_log` 有 1 行 `snooze`(alarm_id=x)。
- 再 `POST` 同 `snz_x` → `legacy_alarms` 中 `snz_x` 行数仍为 1（覆盖不堆积）。
- `POST` 原闹钟后 `POST` 其 snz → 断言原闹钟行 `timestamp/recurrence` 未变。
- `snz_x`（过去 timestamp）到期 → `fire_log` 出现 `ring` 且 `alarm_id LIKE 'snz\_%'`。
- 源码：`ringSnooze` 处理块含 `'snz_'`、`ringingId`、`kind:'snooze'`；不含把原闹钟 `a.recurrence='none'` 写回。

**F6（后端 + 计数口径 + 前端源码）**
- `GET /api/firelog` 缺 clientId → 400；正常 → 升序；`[from,to)` 边界（`fired_at==to` 排除）。
- `pruneFireLog(now)` 删旧留新。
- 计数口径：snooze 行 + snz ring 行并存，按 §2.6 前端口径计数断言（snoozeCount=1、snoozeRing=1）。
- 源码：`renderToday` 存在、含 `snz_` 前缀判定与 `kind` 徽标、含离线只读提示。

**I3（源码 + 降级）**
- 源码：`detectConflicts`/`checkConflict` 存在；含 `typeof Scheduler==='undefined'` 守卫、`60000`、`60`/`90`、`try`。
- 源码：`saveAlarm`/`commitEdit`/modify 调用 `checkConflict`；冲突分支无 `return`（非阻塞）。

**不变量回归**
- `syncedIds/resyncAllToServer/healPushRegistration` 仍在（源码断言）；`toggle`/`setLegacyEnabled` 未引用它们（沿用 phase1 断言，防回退）。

---

## 7. 待明确/假设
1. **fire_log 是服务端审计**：仅「服务端参与触发」的事件入库（push 在线时完整）；纯离线本地触发不入库——今日视图对离线给「只读提示」，符合「本地优先」。
2. **platform 的 ring 行 `client_id` 为空**：不进 App 今日视图，仅审计/未来按 tenant 查询；若后续要平台视图另开 `/v1/firelog`。
3. **贪睡日志次数**：每次点贪睡写 1 行 `snooze`（再贪睡即累加），"不堆积"指 `legacy_alarms` 的闹钟行（同 `snz_` id 覆盖），非 fire_log。
4. **I3 阈值**：默认 60s / 60 次 / 90 天 / 200 闹钟上限，均可作常量微调，不改接口。
5. **6 个待确认问题**（LLM 路线/多端同步/移动端原生/P0-P1 优先级/LLM 隐私/智能唤醒）本批**均不依赖**，不阻塞。
