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

// 由闹钟子对象计算下一次触发（毫秒）：一次性用绝对时间；重复类复用 computeNext
function nextTriggerMs(alarm) {
  const rec = alarm.recurrence || 'none';
  if (rec === 'none') {
    if (alarm.timestamp) return alarm.timestamp * 1000;
    if (alarm.date && alarm.time) {
      const [Y, M, D] = alarm.date.split('-').map(Number);
      const [hh, mm] = alarm.time.split(':').map(Number);
      return new Date(Y, M - 1, D, hh, mm, 0, 0).getTime();
    }
    return null;
  }
  const anchor = (alarm.timestamp || Math.floor(Date.now() / 1000)) * 1000;
  return computeNext(alarm.time, rec, anchor);
}

// ---------- 重复规则：计算下一次触发（与前端一致） ----------
function computeNext(time, recurrence, anchorTs) {
  const now = Date.now();
  const [hh, mm] = time.split(':').map(Number);
  const at = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
  if (recurrence === 'none') return null;
  if (recurrence === 'daily') { let t = at(new Date()); while (t < now) t += 86400000; return t; }
  if (recurrence === 'weekdays') { let t = at(new Date()), g = 0; while (([0, 6].includes(new Date(t).getDay()) || t < now) && g < 12) { t += 86400000; g++; } return t; }
  if (recurrence === 'weekend') { let t = at(new Date()), g = 0; while ((![0, 6].includes(new Date(t).getDay()) || t < now) && g < 12) { t += 86400000; g++; } return t; }
  if (recurrence.startsWith('weekly:')) { const w = parseInt(recurrence.split(':')[1], 10); let t = at(new Date()), g = 0; while ((new Date(t).getDay() !== w || t < now) && g < 12) { t += 86400000; g++; } return t; }
  if (recurrence.startsWith('every:')) { const n = parseInt(recurrence.split(':')[1], 10) || 1; let t = anchorTs; let g = 0; while (g < 500) { const d = new Date(t); const cand = at(new Date(d.getFullYear(), d.getMonth(), d.getDate())); if (cand >= now) return cand; t += n * 86400000; g++; } return null; }
  if (recurrence.startsWith('biweekly:')) { const w = parseInt(recurrence.split(':')[1], 10); const EPOCH = Date.UTC(2024, 0, 1); const monOf = ts => { const x = new Date(ts); const o = (x.getDay() + 6) % 7; x.setDate(x.getDate() - o); x.setHours(0, 0, 0, 0); return x.getTime(); }; let t = at(new Date(anchorTs)), g = 0; while (g < 60) { const dow = new Date(t).getDay(); const wk = Math.round((monOf(t) - monOf(EPOCH)) / (7 * 86400000)); if (dow === w && t >= now && wk % 2 === 0) return t; t += 86400000; g++; } return null; }
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

// ---------- 限流（按 key 滑动窗口，默认 60/min） ----------
const RATE_WINDOW_MS = 60000;
const rateBuckets = new Map(); // key -> number[]（时间戳）
function checkRateLimit(key, limit) {
  const nowMs = Date.now();
  const arr = rateBuckets.get(key) || [];
  const fresh = arr.filter(t => nowMs - t < RATE_WINDOW_MS);
  if (fresh.length >= limit) {
    rateBuckets.set(key, fresh);
    const retryAfter = Math.ceil((fresh[0] + RATE_WINDOW_MS - nowMs) / 1000);
    return { allowed: false, retryAfter };
  }
  fresh.push(nowMs);
  rateBuckets.set(key, fresh);
  return { allowed: true };
}

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
}

// ---------- Webhook 投递 worker（持久化队列 + 指数退避，最多 8 次） ----------
const DELIVERY_BACKOFF = [1, 2, 4, 8, 16, 32, 60, 60]; // 秒
function deliveryBackoffMs(attempt) { return (DELIVERY_BACKOFF[Math.min(attempt, DELIVERY_BACKOFF.length - 1)] || 60) * 1000; }
async function postWebhookOnce(url, body, sig) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Alarm-Event': 'alarm.fired',
    'X-Alarm-Delivery-Id': crypto.randomBytes(8).toString('hex'),
    'X-Alarm-Signature': sig
  };
  const r = await fetch(url, { method: 'POST', headers, body });
  return r.ok;
}
setInterval(async () => {
  try {
    const due = db.getDueDeliveries(Date.now());
    for (const d of due) {
      try {
        const ok = await postWebhookOnce(d.url, d.body, d.sig);
        if (ok) db.markDeliverySuccess(d.id);
        else db.markDeliveryRetry(d.id, d.attempt + 1, Date.now() + deliveryBackoffMs(d.attempt), 'HTTP 非 2xx');
      } catch (e) {
        db.markDeliveryRetry(d.id, d.attempt + 1, Date.now() + deliveryBackoffMs(d.attempt), e.message);
      }
    }
  } catch (e) { console.warn('[delivery] 队列处理异常', e.message); }
}, 1000);
function verifyWebhook(apiKey, url) {
  const body = JSON.stringify({ event: 'webhook.test', challenge: crypto.randomBytes(8).toString('hex'), message: 'Alarm Agent webhook 连通性测试' });
  const sig = apiKey ? crypto.createHmac('sha256', apiKey).update(body).digest('hex') : '';
  const headers = { 'Content-Type': 'application/json', 'X-Alarm-Event': 'webhook.test', 'X-Alarm-Signature': 'sha256=' + sig };
  return fetch(url, { method: 'POST', headers, body }).then(r => r.ok).catch(() => false);
}

// ---------- 共享解析：规则优先，LLM 兜底（供 /api/parse 与 /v1/parse 复用） ----------
async function resolveParse(text, opts) {
  const rule = parseAlarm(text, opts);
  if (rule.success && rule.confidence >= 0.85) return { ...rule, source: 'rule' };
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

  // 限流（按 key 滑动窗口）
  const limit = (typeof k.rate_limit === 'number' && k.rate_limit > 0) ? k.rate_limit : 60;
  const rl = checkRateLimit(k.key, limit);
  if (!rl.allowed) {
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
    const result = await resolveParse(text, nowArg != null ? { now: nowArg } : undefined);
    bumpUsage(k.key, 'parse_count');
    return sendJSON(res, { ...result, request_id: reqId });
  }

  // ---------- 用量查询（本 key） ----------
  if (url === '/v1/usage' && req.method === 'GET') {
    return sendJSON(res, { tenant: k.tenant, usage: getUsage(k.key), request_id: reqId });
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
        const r = await resolveParse(text, nowArg != null ? { now: nowArg } : undefined);
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
    const result = await resolveParse(text);
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
