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
const { computeNext, nextTriggerMs, endExceeded } = require('./scheduler.js');

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

// ---------- 结构化日志（JSON 行，便于采集到 Loki / ELK / 云端日志） ----------
function log(level, event, fields) {
  const obj = { ts: new Date().toISOString(), level, event };
  if (fields) Object.assign(obj, fields);
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ---------- 静态文件 MIME ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.css': 'text/css'
};

// ---------- 工具 ----------
// 可抛出并携带 HTTP 状态/错误码的异常，便于在请求处理器顶层统一转换
class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
// 请求体上限（默认 64KB）：防止超大 body 耗尽内存；超限抛出 413，由处理器统一响应
const READ_BODY_MAX_BYTES = Number(process.env.ALARM_MAX_BODY_BYTES) || 65536;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, b = '', rejected = false;
    req.on('data', c => {
      if (rejected) return;
      size += c.length;
      if (size > READ_BODY_MAX_BYTES) {
        rejected = true;
        reject(new HttpError(413, 'payload_too_large', '请求体超过 ' + READ_BODY_MAX_BYTES + ' 字节上限'));
        return;
      }
      b += c;
    });
    req.on('end', () => { if (!rejected) { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } } });
    req.on('error', () => { if (!rejected) { rejected = true; reject(new HttpError(400, 'bad_request', '请求体读取失败')); } });
  });
}
function sendJSON(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- 时区校验 / 归一（P3：P0-3 校验 + 回退链来源） ----------
// 统一口径（见 docs/system_design.md §7）：
//   - null / undefined / 空串("") / 纯空白 → 返回 undefined（交由回退链，不视为非法）
//   - 非空串用 Intl 试探，抛错即非法 IANA 名 → 返回 null（调用方应返回 400 invalid_timezone）
//   - 合法 → 返回该 tz 字符串
function normalizeTz(tz) {
  if (tz === undefined || tz === null) return undefined;
  if (typeof tz !== 'string') return undefined;
  if (tz.trim() === '') return undefined;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; }
  catch (e) { return null; }
}

// 计算生效时区（仅服务端 /v1/* 与显式入口使用）：请求 timezone > 租户 keys.default_timezone > 环境变量 ALARM_DEFAULT_TZ_<tenant> > Asia/Shanghai
// 返回 { tz } 或 { error: 'invalid_timezone' }（显式提供了非法 IANA 名时）
function resolveEffectiveTz(provided, key) {
  const norm = normalizeTz(provided);
  if (norm === null) return { error: 'invalid_timezone' };
  const envTz = key && key.tenant ? process.env['ALARM_DEFAULT_TZ_' + key.tenant] : undefined;
  const tz = norm || (key && key.default_timezone) || envTz || 'Asia/Shanghai';
  return { tz };
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
// CORS 白名单（可选）：设置 ALARM_CORS_ORIGINS=https://a.com,https://b.com 后，
// 仅列表中 Origin 会被放行（回显该 Origin + Vary:Origin），其余请求不带 ACAO，浏览器将拦截跨域读取。
// 未设置时回退为 *（开放，适合本地演示）。
const CORS_ORIGINS = (process.env.ALARM_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
function corsHeaders(req) {
  if (!CORS_ORIGINS.length) return CORS_HEADERS;
  const origin = req.headers.origin;
  if (origin && CORS_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Vary': 'Origin'
    };
  }
  return {
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };
}

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

  // CORS 头 + 预检（支持 ALARM_CORS_ORIGINS 白名单）
  const cors = corsHeaders(req);
  for (const k in cors) res.setHeader(k, cors[k]);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
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
    // 时区：显式携带则校验 IANA（非法→400 invalid_timezone）；否则回退链：租户默认 > ALARM_DEFAULT_TZ_<tenant> > 上海
    const tzRes = resolveEffectiveTz(body.timezone, k);
    if (tzRes.error) return standardError(res, tzRes.error, 'timezone 不是合法的 IANA 时区名', 400, reqId);
    const opts = { tz: tzRes.tz };
    if (nowArg != null) opts.now = nowArg;
    if (body.context) opts.context = body.context;
    const result = await resolveParse(text, opts);
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
      // 时区回退链：请求 timezone > 租户默认 > ALARM_DEFAULT_TZ_<tenant> > 上海（显式非法 IANA → 400）
      const tzRes = resolveEffectiveTz(body.timezone, k);
      if (tzRes.error) return standardError(res, tzRes.error, 'timezone 不是合法的 IANA 时区名', 400, reqId);
      const effectiveTz = tzRes.tz;
      let alarm;
      if (text) {
        let nowArg = undefined;
        if (body.now != null) nowArg = typeof body.now === 'number' ? (body.now < 1e12 ? body.now * 1000 : body.now) : body.now;
        const r = await resolveParse(text, nowArg != null ? { now: nowArg, tz: effectiveTz, context: body.context } : { tz: effectiveTz, context: body.context });
        if (!r.success) return sendJSON(res, {
          success: false, needs_clarification: r.needs_clarification !== false,
          clarification: r.clarification || null, ambiguities: r.ambiguities || [], request_id: reqId
        }, 422);
        alarm = JSON.parse(JSON.stringify(r.alarm));
      } else if (body.time) {
        alarm = {
          timestamp: null, datetime: null, date: body.date || null, time: body.time,
          recurrence: body.recurrence || 'none', timezone: effectiveTz,
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
      if (body.timezone) alarm.timezone = effectiveTz;
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
      if (body.timezone != null) {
        const norm = normalizeTz(body.timezone);
        if (norm === null) return standardError(res, 'invalid_timezone', 'timezone 不是合法的 IANA 时区名', 400, reqId);
        rec.alarm.timezone = norm;
      }
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
      const rec = db.createKey({ tenant: k.tenant, label: (body.label || '').trim() || null, rate_limit: body.rate_limit, plan: body.plan, default_timezone: body.default_timezone || null });
      return sendJSON(res, { ...rec, request_id: reqId }, 201);
    }
    return standardError(res, 'method_not_allowed', '该方法不被允许', 405, reqId);
  }

  return standardError(res, 'not_found', '接口不存在', 404, reqId);
  } catch (e) {
    if (e instanceof HttpError) return standardError(res, e.code, e.message, e.status, reqId);
    log('error', 'unhandled_error', { error: e.message, url });
    return standardError(res, 'internal_error', '服务器内部错误', 500, reqId);
  }
}

// ---------- API ----------
// 参考 App 接口（Web Push 演示 + 前端兜底解析）。
// 【安全】可选项 ALARM_APP_KEY：设置后，除 /api/vapid(公开公钥) 外的所有 /api/* 都需携带
//   Authorization: Bearer <APP_KEY> 或请求头 x-app-key: <APP_KEY>，否则 401。
// 未设置时保持开放（本地演示零配置），但会在启动日志提示生产环境应启用。
const APP_API_KEY = process.env.ALARM_APP_KEY || '';
const APP_PARSE_RATE_LIMIT = Number(process.env.ALARM_APP_PARSE_LIMIT) || 120; // /api/parse 全局限流（防绕过平台配额白嫖）
if (!APP_API_KEY) console.warn('[security] 未设置 ALARM_APP_KEY：/api/* 当前开放（仅适合本地演示）。生产部署请设置该环境变量以启用 App Key 鉴权。');

function appError(res, code, message, status) {
  return sendJSON(res, { error: { code, message } }, status);
}

async function handleApi(req, res) {
  const url = req.url.split('?')[0];
  const reqId = genRequestId();

  // CORS（参考 App 多为同源调用；若配置 ALARM_CORS_ORIGINS 则按白名单回显 Origin）
  const cors = corsHeaders(req);
  for (const k in cors) res.setHeader(k, cors[k]);

  // App Key 门控（/api/vapid 公开，无需鉴权）
  if (APP_API_KEY && url !== '/api/vapid') {
    const h = req.headers['authorization'] || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    const provided = m ? m[1].trim() : (req.headers['x-app-key'] || '');
    if (provided !== APP_API_KEY) return appError(res, 'unauthorized', '缺少或错误的 App Key（设置 ALARM_APP_KEY 后需携带）', 401);
  }

  try {
    if (url === '/api/vapid' && req.method === 'GET') {
      return sendJSON(res, { publicKey: vapid.publicKey });
    }
    if (url === '/api/register' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.subscription) return appError(res, 'bad_request', 'missing subscription', 400);
      const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 7);
      db.addSub(id, body.subscription);
      console.log('[register] 新订阅', id);
      return sendJSON(res, { clientId: id });
    }
    if (url === '/api/alarm' && req.method === 'POST') {
      const body = await readBody(req);
      const sub = db.listSubs().find(x => x.id === body.clientId);
      // 时区：参考 App 前端恒发合法 IANA；非法/缺失则兜底上海（/api/* 无租户，不 400）
      const tz = normalizeTz(body.timezone) || 'Asia/Shanghai';
      const alarm = {
        id: body.id || ('al' + Date.now() + Math.random().toString(36).slice(2, 5)),
        clientId: body.clientId,
        subscription: sub ? sub.subscription : body.subscription,
        timestamp: body.timestamp, time: body.time, recurrence: body.recurrence || 'none',
        label: body.label || '', lead_minutes: body.lead_minutes || 0, timezone: tz,
        end: body.end || null, fired: false, fired_count: body.fired_count || 0, nextTrigger: (body.timestamp || 0) * 1000
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
      // 全局限流：/api/parse 不经过平台按 key 配额，需独立限流防止被白嫖刷量
      const rl = db.checkRateLimit('app:parse', APP_PARSE_RATE_LIMIT, RATE_WINDOW_MS);
      if (!rl.allowed) { res.setHeader('Retry-After', String(rl.retryAfter)); return appError(res, 'rate_limited', '请求过于频繁，请稍后重试', 429); }
      const body = await readBody(req);
      const text = (body.text || '').trim();
      if (!text) return appError(res, 'bad_request', 'missing text', 400);
      // 时区：显式携带则校验 IANA（非法→400 invalid_timezone）；缺失兜底上海（/api/* 无租户）
      const norm = normalizeTz(body.timezone);
      if (norm === null) return appError(res, 'invalid_timezone', 'timezone 不是合法的 IANA 时区名', 400);
      const tz = norm || 'Asia/Shanghai';
      const opts = { tz };
      if (body.context) opts.context = body.context;
      const result = await resolveParse(text, opts);
      return sendJSON(res, { ...result, request_id: reqId });
    }
    return appError(res, 'not_found', 'not found', 404);
  } catch (e) {
    if (e instanceof HttpError) return appError(res, e.code, e.message, e.status);
    log('error', 'api_unhandled_error', { error: e.message, url });
    return appError(res, 'internal_error', '服务器内部错误', 500);
  }
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
    let out = data;
    // 向首页注入 App Key 占位符（仅当启用 ALARM_APP_KEY 时）：让同源前端自动携带 x-app-key，
    // 从而满足 /api/* 的 App Key 门控；跨域攻击者无法读取该值（CORS 阻止），实现轻量防护。
    if (fp.endsWith('index.html') && APP_API_KEY) {
      out = Buffer.from(data.toString('utf8').replace('__APP_API_KEY__', APP_API_KEY), 'utf8');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(out);
  });
});

// ---------- 推送调度（每秒检查） ----------
const MISS_GRACE = 120000; // 若超过 2 分钟未推送（如服务宕机），视为错过，不再补发
setInterval(() => {
  const now = Date.now();
  // 参考 App 本地闹钟（Web Push）
  for (const a of db.listLegacyAlarms()) {
    if (!a.nextTrigger || a.fired || a.nextTrigger > now) continue;
    const tz = a.timezone || 'Asia/Shanghai';
    if (now - a.nextTrigger > MISS_GRACE) { // 错过
      if (a.recurrence === 'none') a.fired = true;
      else {
        const base = computeNext(a.time, a.recurrence, a.timestamp * 1000, tz);
        const ended = base == null || endExceeded({ time: a.time, recurrence: a.recurrence, timestamp: a.timestamp, end: a.end, lead_minutes: a.lead_minutes }, base, tz);
        a.fired = ended; a.nextTrigger = ended ? 0 : base - (a.lead_minutes || 0) * 60000;
      }
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
    else {
      const base = computeNext(a.time, a.recurrence, a.timestamp * 1000, tz);
      const ended = base == null || endExceeded({ time: a.time, recurrence: a.recurrence, timestamp: a.timestamp, end: a.end, lead_minutes: a.lead_minutes }, base, tz);
      a.fired = ended; a.nextTrigger = ended ? 0 : base - (a.lead_minutes || 0) * 60000;
      // 次数终止：每次触发累加，达到上限即停
      if (a.end && a.end.type === 'count') {
        a.fired_count = (a.fired_count || 0) + 1;
        if (a.fired_count >= a.end.count) { a.fired = true; a.nextTrigger = 0; }
      }
    }
    db.saveLegacyAlarm(a);
  }
  // 平台托管闹钟：状态推进 + Webhook 投递（Phase 3 + 持久化队列）
  for (const a of db.getAllAlarms()) {
    if (!a.enabled || !a.next_trigger || a.next_trigger > now) continue;
    const keyRec = db.getEnabledKeyForTenant(a.tenant);
    const wh = a.webhook_url || (keyRec && keyRec.webhook_url);
    if (wh && keyRec) enqueueWebhookDelivery(keyRec.key, wh, a, now);
    if (keyRec) bumpUsage(keyRec.key, 'fire_count');
    const al = a.alarm;
    if (al.recurrence === 'none') a.next_trigger = null;
    else {
      a.next_trigger = nextTriggerMs(al); // 含日期/天数终止（返回 null 即停）
      // 次数终止：每次触发累加，达到上限即停
      if (al.end && al.end.type === 'count') {
        al.fired_count = (al.fired_count || 0) + 1;
        if (al.fired_count >= al.end.count) a.next_trigger = null;
      }
    }
    a.updated_at = new Date().toISOString();
    db.saveAlarm(a);
  }
}, 1000);

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('闹钟 Agent 服务端已启动： http://localhost:' + PORT);
  console.log('在浏览器打开该地址并点「开启云端推送」即可体验关浏览器也能响。');
});
