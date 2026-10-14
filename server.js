/* ============================================================
 * server.js — 闹钟 Agent 最小服务端
 * 职责：
 *   1) 托管静态前端（index.html / nlu.js / sw.js / ...）
 *   2) 提供 Web Push 所需的 VAPID 公钥
 *   3) 接收客户端订阅与闹钟，按时间通过 Web Push 发送提醒
 *      —— 解决「浏览器/标签页关闭后也能响」的可靠性问题
 * 运行： node server.js   （默认端口 8080，可用 PORT 环境变量覆盖）
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const crypto = require('crypto');
const { parseAlarm } = require('./nlu.js');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ---------- VAPID 密钥（首次自动生成并持久化） ----------
const VAPID_PATH = path.join(DATA, 'vapid.json');
let vapid;
if (fs.existsSync(VAPID_PATH)) {
  vapid = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
} else {
  vapid = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_PATH, JSON.stringify(vapid, null, 2));
  console.log('[vapid] 已生成并保存到 data/vapid.json');
}
webpush.setVapidDetails('mailto:alarm-agent@example.com', vapid.publicKey, vapid.privateKey);

// ---------- 持久化存储（SQLite：开放平台 + 参考 App 数据，统一入库） ----------
const db = require('./db.js');
const { PLANS } = db;

// ---------- 时区感知工具（夏令时安全：把「墙钟 日期+时间+IANA 时区」转为 UTC 毫秒） ----------
function tzOffsetAt(tz, epoch) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : (+p.hour);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUtc - epoch;
}
function wallToEpoch(y, mo, d, hh, mm, tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  let off = tzOffsetAt(tz, guess);
  let utc = guess - off;
  const off2 = tzOffsetAt(tz, utc); // DST 边界二次修正（处理春进/秋退切换日）
  if (off2 !== off) utc = guess - off2;
  return utc;
}
function tzDateParts(epoch, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day };
}
function addDays(y, mo, d, n) { const dt = new Date(Date.UTC(y, mo - 1, d)); dt.setUTCDate(dt.getUTCDate() + n); return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; }
function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }
function weekdayOf(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }

// ---------- 结构化日志（JSON 行，便于采集到 Loki / ELK / 云端日志） ----------
function log(level, event, fields) {
  const obj = { ts: new Date().toISOString(), level, event };
  if (fields) Object.assign(obj, fields);
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// 由闹钟子对象计算下一次触发（毫秒）：一次性优先用绝对时间戳；显式 date+time 按闹钟时区换算（夏令时安全）
function nextTriggerMs(alarm) {
  const rec = alarm.recurrence || 'none';
  const tz = alarm.timezone || 'Asia/Shanghai';
  if (rec === 'none') {
    if (alarm.timestamp) return alarm.timestamp * 1000;
    if (alarm.date && alarm.time) {
      const [Y, M, D] = alarm.date.split('-').map(Number);
      const [hh, mm] = alarm.time.split(':').map(Number);
      return wallToEpoch(Y, M, D, hh, mm, tz);
    }
    return null;
  }
  const anchor = (alarm.timestamp || Math.floor(Date.now() / 1000)) * 1000;
  return computeNext(alarm.time, rec, anchor, tz);
}

// ---------- 重复规则：计算下一次触发（时区感知，支持夏令时 + 月度） ----------
function computeNext(time, recurrence, anchorTs, timezone) {
  const tz = timezone || 'Asia/Shanghai';
  const now = Date.now();
  const [hh, mm] = time.split(':').map(Number);
  if (recurrence === 'none') return null;
  if (!/^\d{1,2}:\d{2}$/.test(time)) return null;
  const at = (y, mo, d) => wallToEpoch(y, mo, d, hh, mm, tz);
  // 以「时区内的日历日」为步进来找下一次触发，避免本地时区与闹钟时区错位
  if (recurrence === 'daily') {
    let cur = tzDateParts(now, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while (t < now && g < 400) { cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return t;
  }
  if (recurrence === 'weekdays') {
    let cur = tzDateParts(now, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while ((weekdayOf(cur.y, cur.mo, cur.d) === 0 || weekdayOf(cur.y, cur.mo, cur.d) === 6 || t < now) && g < 400) { cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return t;
  }
  if (recurrence === 'weekend') {
    let cur = tzDateParts(now, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while ((weekdayOf(cur.y, cur.mo, cur.d) !== 0 && weekdayOf(cur.y, cur.mo, cur.d) !== 6 || t < now) && g < 400) { cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return t;
  }
  if (recurrence.startsWith('weekly:')) {
    const w = parseInt(recurrence.split(':')[1], 10);
    let cur = tzDateParts(now, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while ((weekdayOf(cur.y, cur.mo, cur.d) !== w || t < now) && g < 400) { cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return t;
  }
  if (recurrence.startsWith('every:')) {
    const n = parseInt(recurrence.split(':')[1], 10) || 1;
    let cur = tzDateParts(anchorTs, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while (g < 600) { if (t >= now) return t; cur = addDays(cur.y, cur.mo, cur.d, n); t = at(cur.y, cur.mo, cur.d); g++; }
    return null;
  }
  if (recurrence.startsWith('biweekly:')) {
    const w = parseInt(recurrence.split(':')[1], 10);
    const EPOCH = Date.UTC(2024, 0, 1);
    const monOf = ts => { const x = tzDateParts(ts, tz); const dx = new Date(Date.UTC(x.y, x.mo - 1, x.d)); const o = (dx.getUTCDay() + 6) % 7; dx.setUTCDate(dx.getUTCDate() - o); return dx.getTime(); };
    let cur = tzDateParts(anchorTs, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while (g < 120) { const dow = weekdayOf(cur.y, cur.mo, cur.d); const wk = Math.round((monOf(t) - EPOCH) / (7 * 86400000)); if (dow === w && t >= now && wk % 2 === 0) return t; cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return null;
  }
  if (recurrence.startsWith('monthly:')) {
    const day = parseInt(recurrence.split(':')[1], 10);
    let cur = tzDateParts(now, tz); let y = cur.y, mo = cur.mo, g = 0;
    while (g < 36) {
      const dd = Math.min(day, daysInMonth(y, mo));
      const t = at(y, mo, dd);
      if (t >= now) return t;
      mo++; if (mo > 12) { mo = 1; y++; }
      g++;
    }
    return null;
  }
  return null;
}

// ---------- 静态文件 MIME ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.css': 'text/css'
};

// ---------- 工具 ----------
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}
function sendJSON(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- LLM 长尾兜底解析（预留 key 位，最大化降成本） ----------
// 仅当配置了 ALARM_LLM_KEY 时才调用；否则返回 null，由上层降级为规则结果。
async function llmParse(text) {
  const key = process.env.ALARM_LLM_KEY;
  if (!key) return null;
  const base = (process.env.ALARM_LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = process.env.ALARM_LLM_MODEL || 'gpt-4o-mini';
  const now = new Date();
  const nowISO = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const nowTs = Math.floor(now.getTime() / 1000);
  const sys = `你是一个「中文自然语言 → 闹钟时间」解析器。用户输入一句中文（可能口语化、含糊、含相对/绝对时间、重复、动作）。请解析并返回严格 JSON：{"success":true|false,"raw":"<原输入>","alarm":{"timestamp":<Unix秒级时间戳,UTC,基于下方当前时间推算>,"datetime":"<ISO8601 含 +08:00>","date":"<YYYY-MM-DD>","time":"<HH:MM 24小时制>","recurrence":"none|daily|weekdays|weekend|weekly:N(0=周日)","timezone":"Asia/Shanghai","label":"<动作简述>"},"confidence":<0~1>,"needs_clarification":true|false,"ambiguities":["<无法确认时间时的中文澄清提示>"]}。规则：时区固定 Asia/Shanghai(UTC+8,无夏令时)；当前时间(东八区)参考：${nowISO}（Unix秒≈${nowTs}）；单次=none,每天=daily,工作日=weekdays,周末=weekend,每周某天=weekly:N；无法确定时间则 success=false,needs_clarification=true；只输出 JSON，不要解释或代码块。`;
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }], temperature: 0 })
    });
    if (!r.ok) { console.warn('[llm] HTTP', r.status); return null; }
    const j = await r.json();
    let content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(content);
    const a = parsed.alarm;
    if (!parsed || !a || typeof a.timestamp !== 'number' || !/^\d{2}:\d{2}$/.test(a.time || '')) return null;
    a.timezone = a.timezone || 'Asia/Shanghai';
    if (typeof parsed.confidence !== 'number') parsed.confidence = 0.9;
    if (typeof parsed.needs_clarification !== 'boolean') parsed.needs_clarification = !parsed.success;
    if (!Array.isArray(parsed.ambiguities)) parsed.ambiguities = parsed.ambiguities ? [parsed.ambiguities] : [];
    return parsed;
  } catch (e) { console.warn('[llm] 解析失败', e.message); return null; }
}

// ============================================================
// 开放 API（v1）：对外暴露解析能力，独立于内部 /api/*
// 包含 API Key 鉴权、按 key 限流、CORS、标准错误、确定性 now 覆盖
// ============================================================
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

// ---------- API Key（密钥存储已迁移至 db.js，启动时自动建示例密钥） ----------
function genRequestId() { return 'req_' + crypto.randomBytes(10).toString('hex'); }
function standardError(res, code, message, status, reqId) {
  return sendJSON(res, { error: { code, message }, request_id: reqId }, status);
}

// ---------- 限流（按 key 滑动窗口，默认 60/min；持久化到 SQLite，重启不丢） ----------
const RATE_WINDOW_MS = 60000;
// 旧的内存态实现已迁移到 db.checkRateLimit（见下方调用处）。

// ---------- 用量计量（按 key 计，为计费打地基；存储已迁移至 db.js） ----------
function getUsage(key) { return db.getUsage(key); }
function bumpUsage(key, field) { return db.bumpUsage(key, field); }

// ---------- Webhook 投递（Phase 3：让托管闹钟触发时通知到开发者业务） ----------
// 触发时只把投递事件「入队」（持久化），真正发送由独立的投递 worker 异步完成，
// 因此进程崩溃/重启不会丢失在途投递（崩溃恢复 = 重启后 worker 继续处理 pending 行）。
function enqueueWebhookDelivery(rawKey, url, a, nowMs) {
  const payload = JSON.stringify({
    event: 'alarm.fired',
    alarm_id: a.id,
    tenant: a.tenant,
    text: a.text,
    alarm: a.alarm,
    fired_at: new Date(nowMs).toISOString(),
    request_id: genRequestId()
  });
  const sig = rawKey ? crypto.createHmac('sha256', rawKey).update(payload).digest('hex') : '';
  db.enqueueDelivery({ tenant: a.tenant, url, body: payload, sig: 'sha256=' + sig });
  db.incrMetric('delivery_enqueued', 1);
}

// ---------- Webhook 投递 worker（持久化队列 + 指数退避，最多 8 次） ----------
const DELIVERY_BACKOFF = [1, 2, 4, 8, 16, 32, 60, 60]; // 秒
function deliveryBackoffMs(attempt) { return (DELIVERY_BACKOFF[Math.min(attempt, DELIVERY_BACKOFF.length - 1)] || 60) * 1000; }
const DELIVERY_TIMEOUT_MS = 5000;    // 单次 Webhook POST 超时，避免挂起堆积
const DELIVERY_RECOVER_MS = 120000;  // processing 行超过 2 分钟未推进则视为卡死，回退重试
const DELIVERY_PRUNE_MS = 7 * 24 * 3600 * 1000; // 终态投递行保留 7 天后清理
async function postWebhookOnce(url, body, sig, timeoutMs = DELIVERY_TIMEOUT_MS) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Alarm-Event': 'alarm.fired',
    'X-Alarm-Delivery-Id': crypto.randomBytes(8).toString('hex'),
    'X-Alarm-Signature': sig
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
    return r.ok;
  } finally {
    clearTimeout(timer);
  }
}

// 投递 worker：单飞（delivering 标志防同进程重叠 tick）+ 跨实例原子抢占（claimDelivery）+ 崩溃恢复
let delivering = false;
setInterval(async () => {
  if (delivering) return; // 上一轮仍在跑（fetch 慢），跳过本 tick，下个周期再扫
  delivering = true;
  try {
    // 崩溃恢复：回退长时间卡在 processing 的行（进程被 kill 时未写回）
    db.recoverStuckDeliveries(Date.now() - DELIVERY_RECOVER_MS);
    const due = db.getDueDeliveries(Date.now());
    for (const d of due) {
      // 原子抢占：仅当仍是 pending 才置 processing，跨实例/跨 tick 重复扫描都不会双发
      if (!db.claimDelivery(d.id)) continue;
      try {
        const ok = await postWebhookOnce(d.url, d.body, d.sig);
        if (ok) {
          db.markDeliverySuccess(d.id);
          db.incrMetric('delivery_success', 1);
          log('info', 'delivery_success', { id: d.id, tenant: d.tenant });
        } else {
          const attempt = d.attempt + 1;
          const final = attempt >= db.DELIVERY_MAX_ATTEMPTS;
          db.markDeliveryRetry(d.id, attempt, Date.now() + deliveryBackoffMs(d.attempt), 'HTTP 非 2xx');
          if (final) { db.incrMetric('delivery_failed_final', 1); log('error', 'delivery_failed_final', { id: d.id, tenant: d.tenant, attempts: attempt }); }
          else { db.incrMetric('delivery_attempts_failed', 1); }
        }
      } catch (e) {
        const attempt = d.attempt + 1;
        const final = attempt >= db.DELIVERY_MAX_ATTEMPTS;
        db.markDeliveryRetry(d.id, attempt, Date.now() + deliveryBackoffMs(d.attempt), e.message);
        if (final) { db.incrMetric('delivery_failed_final', 1); log('error', 'delivery_failed_final', { id: d.id, tenant: d.tenant, error: e.message }); }
        else { db.incrMetric('delivery_attempts_failed', 1); }
      }
    }
  } catch (e) { log('error', 'delivery_worker_error', { error: e.message }); }
  finally { delivering = false; }
}, 1000);

// 定期清理过期记录：限流（1 分钟窗口）+ 终态投递（7 天保留期），防止表无限膨胀
setInterval(() => { try { db.pruneStaleRateEvents(Date.now() - RATE_WINDOW_MS); } catch (e) {} }, 60000);
setInterval(() => { try { const n = db.pruneDeliveries(Date.now() - DELIVERY_PRUNE_MS); if (n > 0) log('info', 'delivery_pruned', { count: n }); } catch (e) {} }, 3600 * 1000);
function verifyWebhook(apiKey, url) {
  const body = JSON.stringify({ event: 'webhook.test', challenge: crypto.randomBytes(8).toString('hex'), message: 'Alarm Agent webhook 连通性测试' });
  const sig = apiKey ? crypto.createHmac('sha256', apiKey).update(body).digest('hex') : '';
  const headers = { 'Content-Type': 'application/json', 'X-Alarm-Event': 'webhook.test', 'X-Alarm-Signature': 'sha256=' + sig };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
  return fetch(url, { method: 'POST', headers, body, signal: ctrl.signal })
    .then(r => r.ok).catch(() => false)
    .finally(() => clearTimeout(timer));
}

// ---------- 共享解析：规则优先，LLM 兜底（供 /api/parse 与 /v1/parse 复用） ----------
async function resolveParse(text, opts) {
  const rule = parseAlarm(text, opts);
  if (rule.success && rule.confidence >= 0.85) return { ...rule, source: 'rule' };
  // 多轮澄清（带 context）不交给 LLM，保持确定性合并，避免乱覆盖已理解锚点
  if (opts && opts.context) return { ...rule, source: 'rule' };
  const llm = await llmParse(text);
  if (llm) return { ...llm, source: 'llm' };
  return { ...rule, source: 'rule' };
}

// ---------- 开放 API 入口 ----------
async function handleOpenApi(req, res) {
  const url = req.url.split('?')[0];
  const reqId = genRequestId();

  // CORS 头 + 预检
  for (const k in CORS_HEADERS) res.setHeader(k, CORS_HEADERS[k]);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // 健康检查（免鉴权）
  if (url === '/v1/health' && req.method === 'GET') {
    return sendJSON(res, { status: 'ok', version: '1.0.0', request_id: reqId });
  }
  if (!url.startsWith('/v1/')) return standardError(res, 'not_found', '接口不存在', 404, reqId);

  // 鉴权：Authorization: Bearer <API_KEY>
  const auth = req.headers['authorization'] || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return standardError(res, 'missing_api_key', '缺少 Authorization: Bearer <API_KEY> 头', 401, reqId);
  const provided = m[1].trim();
  const k = db.getKey(provided);
  if (!k) return standardError(res, 'invalid_api_key', 'API Key 无效或已禁用', 401, reqId);
  if (k.enabled === false) return standardError(res, 'key_disabled', '该 API Key 已被禁用', 403, reqId);

  // 限流（按 key 滑动窗口；持久化到 SQLite，重启不丢、同库多实例可共享）
  const limit = (typeof k.rate_limit === 'number' && k.rate_limit > 0) ? k.rate_limit : 60;
  const rl = db.checkRateLimit(k.key, limit, RATE_WINDOW_MS);
  if (!rl.allowed) {
    log('warn', 'rate_limited', { key: k.key.slice(0, 10) + '…', limit, retry_after: rl.retryAfter });
    res.setHeader('Retry-After', String(rl.retryAfter));
    return standardError(res, 'rate_limited', '请求过于频繁，请稍后重试', 429, reqId);
  }

  // 路由
  if (url === '/v1/parse' && req.method === 'POST') {
    const body = await readBody(req);
    const text = (body.text || '').trim();
    if (!text) return standardError(res, 'bad_request', '缺少必填字段 text', 400, reqId);
    if (text.length > 200) return standardError(res, 'bad_request', 'text 超过 200 字上限', 400, reqId);
    // 计费套餐：月度解析配额（滚动 30 天），超额返回 402
    const u0 = db.getUsage(k.key);
    if (u0.quota != null && u0.parse_count >= u0.quota) {
      return standardError(res, 'quota_exceeded', `本月解析配额（${u0.quota}）已用尽，请升级套餐或下个计费周期再试`, 402, reqId);
    }
    // now 覆盖（确定性测试 / 回放）；支持 ISO 字符串或 Unix 秒/毫秒数字
    let nowArg = undefined;
    if (body.now != null) {
      if (typeof body.now === 'number') nowArg = body.now < 1e12 ? body.now * 1000 : body.now;
      else nowArg = body.now;
    }
    const t0 = Date.now();
    const result = await resolveParse(text, nowArg != null ? { now: nowArg, context: body.context } : (body.context ? { context: body.context } : undefined));
    const elapsed = Date.now() - t0;
    db.incrMetric('parse_total', 1);
    db.incrMetric('parse_latency_sum_ms', elapsed);
    bumpUsage(k.key, 'parse_count');
    log('info', 'parse', { tenant: k.tenant, source: result.source, latency_ms: elapsed, length: text.length });
    return sendJSON(res, { ...result, request_id: reqId });
  }

  // ---------- 用量查询（本 key） ----------
  if (url === '/v1/usage' && req.method === 'GET') {
    return sendJSON(res, { tenant: k.tenant, usage: getUsage(k.key), request_id: reqId });
  }

  // ---------- 指标（全局聚合：投递成功率 / 解析耗时 等） ----------
  if (url === '/v1/metrics' && req.method === 'GET') {
    const m = db.getMetrics();
    const parseTotal = m.parse_total || 0, latencySum = m.parse_latency_sum_ms || 0;
    const succ = m.delivery_success || 0, fail = m.delivery_failed_final || 0;
    return sendJSON(res, {
      metrics: m,
      derived: {
        parse_avg_latency_ms: parseTotal ? Number((latencySum / parseTotal).toFixed(2)) : 0,
        delivery_success_rate: (succ + fail) > 0 ? Number((succ / (succ + fail)).toFixed(4)) : null
      },
      request_id: reqId
    });
  }

  // ---------- Webhook 配置（租户级回调 URL） ----------
  if (url === '/v1/webhook' && req.method === 'GET') {
    return sendJSON(res, { url: k.webhook_url || null, verified: !!k.webhook_verified, request_id: reqId });
  }
  if (url === '/v1/webhook' && req.method === 'POST') {
    const body = await readBody(req);
    const u = (body.url || '').trim();
    if (!u) { // 清空
      db.setWebhook(k.key, null, false);
      return sendJSON(res, { ok: true, url: null, verified: false, request_id: reqId });
    }
    let parsed;
    try { parsed = new URL(u); } catch (e) { return standardError(res, 'bad_request', 'webhook_url 不是合法 URL', 400, reqId); }
    if (parsed.protocol !== 'https:' && !(parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')) {
      return standardError(res, 'bad_request', 'webhook_url 必须为 https（本地联调用 http://localhost 允许）', 400, reqId);
    }
    const ok = await verifyWebhook(k.key, u);
    db.setWebhook(k.key, u, ok);
    return sendJSON(res, { ok: true, url: u, verified: ok, request_id: reqId });
  }

  // ---------- 托管闹钟 CRUD（多租户，按 key 的 tenant 隔离，存储于 db） ----------
  const alarmsMatch = url.match(/^\/v1\/alarms(?:\/([\w-]+))?$/);
  if (alarmsMatch) {
    const id = alarmsMatch[1];
    if (!id && req.method === 'POST') {
      const body = await readBody(req);
      const text = (body.text || '').trim();
      // 幂等：同租户内 idempotency_key 重复 → 返回已有记录
      if (body.idempotency_key) {
        const ex = db.findAlarmByIdempotency(k.tenant, body.idempotency_key);
        if (ex) return sendJSON(res, { ...ex, idempotent: true, request_id: reqId });
      }
      let alarm;
      if (text) {
        let nowArg = undefined;
        if (body.now != null) nowArg = typeof body.now === 'number' ? (body.now < 1e12 ? body.now * 1000 : body.now) : body.now;
        const r = await resolveParse(text, nowArg != null ? { now: nowArg, context: body.context } : (body.context ? { context: body.context } : undefined));
        if (!r.success) return sendJSON(res, {
          success: false, needs_clarification: r.needs_clarification !== false,
          clarification: r.clarification || null, ambiguities: r.ambiguities || [], request_id: reqId
        }, 422);
        alarm = JSON.parse(JSON.stringify(r.alarm));
      } else if (body.time) {
        alarm = {
          timestamp: null, datetime: null, date: body.date || null, time: body.time,
          recurrence: body.recurrence || 'none', timezone: body.timezone || 'Asia/Shanghai',
          label: body.label || '', enabled: true, lead_minutes: body.lead_minutes || 0
        };
      } else {
        return standardError(res, 'bad_request', '需提供 text（自然语言）或 time（显式时间）', 400, reqId);
      }
      // 显式字段覆盖解析结果
      if (body.recurrence) alarm.recurrence = body.recurrence;
      if (body.time) alarm.time = body.time;
      if (body.date) alarm.date = body.date;
      if (body.label != null) alarm.label = body.label;
      if (body.timezone) alarm.timezone = body.timezone;
      if (body.lead_minutes != null) alarm.lead_minutes = body.lead_minutes;
      alarm.enabled = body.enabled !== false;
      const rec = {
        id: 'a_' + crypto.randomBytes(8).toString('hex'),
        tenant: k.tenant, text: text || null, alarm,
        webhook_url: body.webhook_url || null,
        enabled: alarm.enabled, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        idempotency_key: body.idempotency_key || null, next_trigger: nextTriggerMs(alarm)
      };
      db.saveAlarm(rec);
      bumpUsage(k.key, 'alarm_create');
      return sendJSON(res, { ...rec, request_id: reqId }, 201);
    }
    if (!id && req.method === 'GET') {
      let enabled = undefined;
      if (req.url.includes('enabled=true')) enabled = true;
      else if (req.url.includes('enabled=false')) enabled = false;
      const limit = parseInt((req.url.match(/limit=(\d+)/) || [])[1] || '0', 10);
      const arr = db.getAlarmsByTenant(k.tenant, { enabled, limit });
      return sendJSON(res, { count: arr.length, alarms: arr, request_id: reqId });
    }
    if (id && req.method === 'GET') {
      const rec = db.getAlarm(k.tenant, id);
      if (!rec) return standardError(res, 'not_found', '闹钟不存在', 404, reqId);
      return sendJSON(res, { ...rec, request_id: reqId });
    }
    if (id && req.method === 'PATCH') {
      const rec = db.getAlarm(k.tenant, id);
      if (!rec) return standardError(res, 'not_found', '闹钟不存在', 404, reqId);
      const body = await readBody(req);
      if (body.text != null && body.text.trim()) {
        const r = await resolveParse(body.text.trim());
        if (r.success) rec.alarm = JSON.parse(JSON.stringify(r.alarm));
      }
      if (body.recurrence != null) rec.alarm.recurrence = body.recurrence;
      if (body.time != null) rec.alarm.time = body.time;
      if (body.date != null) rec.alarm.date = body.date;
      if (body.label != null) rec.alarm.label = body.label;
      if (body.timezone != null) rec.alarm.timezone = body.timezone;
      if (body.lead_minutes != null) rec.alarm.lead_minutes = body.lead_minutes;
      if (body.enabled !== undefined) rec.enabled = !!body.enabled;
      rec.alarm.enabled = rec.enabled;
      rec.updated_at = new Date().toISOString();
      rec.next_trigger = nextTriggerMs(rec.alarm);
      db.saveAlarm(rec);
      bumpUsage(k.key, 'alarm_update');
      return sendJSON(res, { ...rec, request_id: reqId });
    }
    if (id && req.method === 'DELETE') {
      const ok = db.deleteAlarm(k.tenant, id);
      if (!ok) return standardError(res, 'not_found', '闹钟不存在', 404, reqId);
      bumpUsage(k.key, 'alarm_delete');
      return sendJSON(res, { ok: true, id, request_id: reqId });
    }
    return standardError(res, 'method_not_allowed', '该方法不被允许', 405, reqId);
  }

  // ---------- 密钥自助管理（仅能管理本租户密钥） ----------
  const keysMatch = url.match(/^\/v1\/keys(?:\/([\w-]+)\/(disable|enable))?$/);
  if (keysMatch) {
    const sub = keysMatch[1];
    const action = keysMatch[2];
    if (sub && action && req.method === 'POST') {
      const target = db.getKey(sub);
      if (!target || target.tenant !== k.tenant) return standardError(res, 'not_found', '密钥不存在或不属于当前租户', 404, reqId);
      if (action === 'disable') { db.setKeyEnabled(sub, false); return sendJSON(res, { ok: true, key: sub, enabled: false, request_id: reqId }); }
      if (action === 'enable') { db.setKeyEnabled(sub, true); return sendJSON(res, { ok: true, key: sub, enabled: true, request_id: reqId }); }
    }
    if (!sub && req.method === 'GET') {
      const list = db.listKeys(k.tenant).map(kk => ({
        key: kk.key.slice(0, 10) + '…' + kk.key.slice(-4), tenant: kk.tenant, label: kk.label,
        enabled: kk.enabled, rate_limit: kk.rate_limit, plan: kk.plan, created_at: kk.created_at
      }));
      return sendJSON(res, { count: list.length, keys: list, request_id: reqId });
    }
    if (!sub && req.method === 'POST') {
      const body = await readBody(req);
      const rec = db.createKey({ tenant: k.tenant, label: (body.label || '').trim() || null, rate_limit: body.rate_limit, plan: body.plan });
      return sendJSON(res, { ...rec, request_id: reqId }, 201);
    }
    return standardError(res, 'method_not_allowed', '该方法不被允许', 405, reqId);
  }

  return standardError(res, 'not_found', '接口不存在', 404, reqId);
}

// ---------- API ----------
async function handleApi(req, res) {
  const url = req.url.split('?')[0];
  if (url === '/api/vapid' && req.method === 'GET') {
    return sendJSON(res, { publicKey: vapid.publicKey });
  }
  if (url === '/api/register' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.subscription) return sendJSON(res, { error: 'missing subscription' }, 400);
    const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 7);
    db.addSub(id, body.subscription);
    console.log('[register] 新订阅', id);
    return sendJSON(res, { clientId: id });
  }
  if (url === '/api/alarm' && req.method === 'POST') {
    const body = await readBody(req);
    const sub = db.listSubs().find(x => x.id === body.clientId);
    const alarm = {
      id: body.id || ('al' + Date.now() + Math.random().toString(36).slice(2, 5)),
      clientId: body.clientId,
      subscription: sub ? sub.subscription : body.subscription,
      timestamp: body.timestamp, time: body.time, recurrence: body.recurrence || 'none',
      label: body.label || '', fired: false, nextTrigger: (body.timestamp || 0) * 1000
    };
    db.saveLegacyAlarm(alarm);
    console.log('[alarm] 已登记', alarm.id, alarm.time, alarm.recurrence);
    return sendJSON(res, { ok: true, id: alarm.id });
  }
  if (url === '/api/alarm/remove' && req.method === 'POST') {
    const body = await readBody(req);
    const ok = db.deleteLegacyAlarm(body.clientId, body.id);
    return sendJSON(res, { ok: true, removed: ok ? 1 : 0 });
  }
  if (url === '/api/parse' && req.method === 'POST') {
    const body = await readBody(req);
    const text = (body.text || '').trim();
    if (!text) return sendJSON(res, { error: 'missing text' }, 400);
    const result = await resolveParse(text, body.context ? { context: body.context } : undefined);
    return sendJSON(res, { ...result });
  }
  return sendJSON(res, { error: 'not found' }, 404);
}

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/')) return handleOpenApi(req, res);
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  let p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (p === '/portal' || p === '/portal.html') p = '/portal.html';
  const fp = path.normalize(path.join(ROOT, p));
  if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- 推送调度（每秒检查） ----------
const MISS_GRACE = 120000; // 若超过 2 分钟未推送（如服务宕机），视为错过，不再补发
setInterval(() => {
  const now = Date.now();
  // 参考 App 本地闹钟（Web Push）
  for (const a of db.listLegacyAlarms()) {
    if (!a.nextTrigger || a.fired || a.nextTrigger > now) continue;
    if (now - a.nextTrigger > MISS_GRACE) { // 错过
      if (a.recurrence === 'none') a.fired = true; else a.nextTrigger = computeNext(a.time, a.recurrence, a.timestamp * 1000);
      db.saveLegacyAlarm(a); continue;
    }
    if (a.subscription) {
      const payload = JSON.stringify({ title: '⏰ 闹钟', body: (a.label || '时间到') + '  ·  ' + a.time, time: a.time });
      webpush.sendNotification(a.subscription, payload).catch(err => {
        console.warn('[push] 发送失败', a.id, err.statusCode || err.message);
        if (err.statusCode === 404 || err.statusCode === 410) { // 订阅失效
          db.deleteSub(a.clientId);
        }
      });
    }
    if (a.recurrence === 'none') a.fired = true;
    else a.nextTrigger = computeNext(a.time, a.recurrence, a.timestamp * 1000);
    db.saveLegacyAlarm(a);
  }
  // 平台托管闹钟：状态推进 + Webhook 投递（Phase 3 + 持久化队列）
  for (const a of db.getAllAlarms()) {
    if (!a.enabled || !a.next_trigger || a.next_trigger > now) continue;
    const keyRec = db.getEnabledKeyForTenant(a.tenant);
    const wh = a.webhook_url || (keyRec && keyRec.webhook_url);
    if (wh && keyRec) enqueueWebhookDelivery(keyRec.key, wh, a, now);
    if (keyRec) bumpUsage(keyRec.key, 'fire_count');
    if (a.alarm.recurrence === 'none') a.next_trigger = null;
    else a.next_trigger = computeNext(a.alarm.time, a.alarm.recurrence, (a.alarm.timestamp || Math.floor(now / 1000)) * 1000);
    a.updated_at = new Date().toISOString();
    db.saveAlarm(a);
  }
}, 1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('闹钟 Agent 服务端已启动： http://localhost:' + PORT);
  console.log('在浏览器打开该地址并点「开启云端推送」即可体验关浏览器也能响。');
});
