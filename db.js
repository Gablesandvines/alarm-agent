/* ============================================================
 * db.js — 闹钟 Agent 开放平台持久层（SQLite，node:sqlite 内置）
 * 职责：以真实数据库替代 JSON 文件，承载 密钥 / 托管闹钟 / 用量 三类数据。
 * 首启自动从旧 JSON（keys.json / alarms.json / usage.json）迁移到库。
 * ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- API Key 安全：哈希存储 + 加密静态保存 ----------
// 鉴权/查找只用 SHA-256 哈希；原始 Key 仅在创建时返回一次，静态落库时以 AES-256-GCM 加密（密钥来自 ALARM_MASTER_KEY）。
// 未设置 ALARM_MASTER_KEY 时退化为「明文 + raw: 前缀」存储并告警（仅开发环境可接受，生产必须设置）。
const MASTER = process.env.ALARM_MASTER_KEY || '';
let _masterWarned = false;
function hashKey(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }
function encryptSecret(plain) {
  if (!MASTER) {
    if (!_masterWarned) { console.warn('[db] 安全提示：未设置 ALARM_MASTER_KEY，API Key 以明文存储。生产环境请设置该环境变量启用 AES-256-GCM 加密。'); _masterWarned = true; }
    return 'raw:' + plain;
  }
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(MASTER).digest(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
function decryptSecret(cipher) {
  if (typeof cipher !== 'string') return cipher;
  if (cipher.startsWith('raw:')) return cipher.slice(4);
  if (!MASTER) return cipher;
  try {
    const buf = Buffer.from(cipher, 'base64');
    const iv = buf.slice(0, 12), tag = buf.slice(12, 28), enc = buf.slice(28);
    const d = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(MASTER).digest(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch (e) { console.warn('[db] 密钥解密失败（可能未设 ALARM_MASTER_KEY 或密钥已损坏）', e.message); return null; }
}

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (e) { console.error('[db] node:sqlite 不可用：', e.message); process.exit(1); }

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
const DB_PATH = process.env.ALARM_DB || path.join(DATA, 'alarm.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA foreign_keys=ON;');

// ---------- 计费套餐 ----------
const PLANS = {
  free:       { label: '免费版', rate_limit: 60,   monthly_parse_quota: 5000 },
  pro:        { label: '专业版', rate_limit: 600,  monthly_parse_quota: 100000 },
  enterprise: { label: '企业版', rate_limit: 6000, monthly_parse_quota: null }
};
const DEFAULT_PLAN = 'free';
const QUOTA_WINDOW_MS = 30 * 24 * 3600 * 1000; // 滚动 30 天计费周期

// ---------- 运行模式：单用户（默认） / 多租户平台 ----------
// 默认单用户模式：多租户 SaaS 平台能力（密钥自助管理、计费套餐）休眠；
// ALARM_PLATFORM=1 时恢复平台模式。
const PLATFORM_MODE = process.env.ALARM_PLATFORM === '1';
// 单用户模式内置密钥（固定值）：tenant='default'，plan='single' 不在 PLANS 中 → 无月度配额；
// rate_limit=1000000 视同不限流。
const SINGLE_USER_KEY = 'sk_single_user';

// ---------- 建表 ----------
db.exec(`
CREATE TABLE IF NOT EXISTS keys (
  key_hash TEXT PRIMARY KEY,
  key_enc TEXT NOT NULL,
  tenant TEXT NOT NULL,
  label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  rate_limit INTEGER,
  plan TEXT NOT NULL DEFAULT 'free',
  webhook_url TEXT,
  webhook_verified INTEGER NOT NULL DEFAULT 0,
  default_timezone TEXT DEFAULT 'Asia/Shanghai',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  url TEXT NOT NULL,
  body TEXT NOT NULL,
  sig TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alarms (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  text TEXT,
  alarm_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_trigger INTEGER,
  idempotency_key TEXT,
  webhook_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  key TEXT PRIMARY KEY,
  parse_count INTEGER NOT NULL DEFAULT 0,
  alarm_create INTEGER NOT NULL DEFAULT 0,
  alarm_update INTEGER NOT NULL DEFAULT 0,
  alarm_delete INTEGER NOT NULL DEFAULT 0,
  fire_count INTEGER NOT NULL DEFAULT 0,
  period_start TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subs (
  id TEXT PRIMARY KEY,
  subscription_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_alarms (
  id TEXT PRIMARY KEY,
  client_id TEXT,
  subscription_json TEXT,
  timestamp INTEGER,
  time TEXT,
  recurrence TEXT,
  label TEXT,
  lead_minutes INTEGER NOT NULL DEFAULT 0,
  fired INTEGER NOT NULL DEFAULT 0,
  next_trigger INTEGER,
  end_json TEXT,
  fired_count INTEGER NOT NULL DEFAULT 0,
  timezone TEXT DEFAULT 'Asia/Shanghai',
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key_ts ON rate_limits(key_hash, ts);
CREATE TABLE IF NOT EXISTS metrics (
  name TEXT PRIMARY KEY,
  value REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
`);

// 旧版以明文 key 为主键的库，迁移为哈希存储（key_hash + 加密 key_enc）
migrateKeysSchema();
// deliveries 表补充 updated_at（崩溃恢复与终态清理依赖），旧库自动 ALTER
migrateDeliveriesSchema();
// legacy_alarms 表补充 lead_minutes（重复闹钟提前提醒依赖），旧库自动 ALTER
migrateLegacyAlarmsSchema();
// legacy_alarms 表补充 enabled 列（F1：单闹钟启停，默认启用），旧库 ALTER 补齐
migrateLegacyAlarmsEnabled();
// keys 表补充 default_timezone（租户级默认时区，P3），旧库自动 ALTER
migrateKeysDefaultTz();

// ---------- 行 <-> 对象 归一 ----------
function rowToKey(r) {
  if (!r) return null;
  return {
    key: decryptSecret(r.key_enc), tenant: r.tenant, label: r.label,
    enabled: !!r.enabled, rate_limit: r.rate_limit, plan: r.plan,
    default_timezone: r.default_timezone || null,
    webhook_url: r.webhook_url || null, webhook_verified: !!r.webhook_verified,
    created_at: r.created_at
  };
}
function rowToAlarm(r) {
  if (!r) return null;
  let alarm;
  try { alarm = JSON.parse(r.alarm_json); } catch (e) { alarm = {}; }
  return {
    id: r.id, tenant: r.tenant, text: r.text || null, alarm,
    enabled: !!r.enabled, next_trigger: r.next_trigger || null,
    idempotency_key: r.idempotency_key || null, webhook_url: r.webhook_url || null,
    created_at: r.created_at, updated_at: r.updated_at
  };
}

// ---------- 密钥 ----------
function getKey(provided) {
  const r = db.prepare('SELECT * FROM keys WHERE key_hash = ?').get(hashKey(provided));
  return rowToKey(r);
}
function listKeys(tenant) {
  const rows = db.prepare('SELECT * FROM keys WHERE tenant = ? ORDER BY created_at DESC').all(tenant);
  return rows.map(rowToKey);
}
function listAllKeys() {
  return db.prepare('SELECT * FROM keys ORDER BY created_at DESC').all().map(rowToKey);
}
function getEnabledKeyForTenant(tenant) {
  const r = db.prepare('SELECT * FROM keys WHERE tenant = ? AND enabled = 1 LIMIT 1').get(tenant);
  return rowToKey(r);
}
function createKey({ tenant, label, rate_limit, plan, default_timezone }) {
  plan = PLANS[plan] ? plan : DEFAULT_PLAN;
  const rate = (typeof rate_limit === 'number' && rate_limit > 0) ? rate_limit : PLANS[plan].rate_limit;
  const key = 'sk_live_' + crypto.randomBytes(18).toString('hex');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO keys (key_hash, key_enc, tenant, label, enabled, rate_limit, plan, default_timezone, created_at) VALUES (?,?,?,?,1,?,?,?,?)')
    .run(hashKey(key), encryptSecret(key), tenant, label || (PLANS[plan].label + ' 密钥'), rate, plan, default_timezone || null, now);
  return getKey(key);
}
function setKeyEnabled(rawKey, enabled) {
  db.prepare('UPDATE keys SET enabled = ? WHERE key_hash = ?').run(enabled ? 1 : 0, hashKey(rawKey));
}
function setWebhook(rawKey, url, verified) {
  db.prepare('UPDATE keys SET webhook_url = ?, webhook_verified = ? WHERE key_hash = ?')
    .run(url || null, verified ? 1 : 0, hashKey(rawKey));
}

// 单用户模式内置密钥：重复调用幂等（已存在则直接返回现有记录）。
// default_timezone 显式传 null，使 P3 时区回退链（ALARM_DEFAULT_TZ_default > Asia/Shanghai）在请求期仍然生效。
function ensureSingleUserKey() {
  const existing = getKey(SINGLE_USER_KEY);
  if (existing) return existing;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO keys (key_hash, key_enc, tenant, label, enabled, rate_limit, plan, default_timezone, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(hashKey(SINGLE_USER_KEY), encryptSecret(SINGLE_USER_KEY), 'default', '单用户默认密钥', 1, 1000000, 'single', null, now);
  return getKey(SINGLE_USER_KEY);
}

// ---------- 托管闹钟 ----------
function getAlarmsByTenant(tenant, { enabled, limit } = {}) {
  let sql = 'SELECT * FROM alarms WHERE tenant = ?';
  const params = [tenant];
  if (enabled === true) sql += ' AND enabled = 1';
  else if (enabled === false) sql += ' AND enabled = 0';
  sql += ' ORDER BY created_at DESC';
  if (limit && limit > 0) { sql += ' LIMIT ?'; params.push(limit); }
  return db.prepare(sql).all(...params).map(rowToAlarm);
}
function getAlarm(tenant, id) {
  return rowToAlarm(db.prepare('SELECT * FROM alarms WHERE tenant = ? AND id = ?').get(tenant, id));
}
function findAlarmByIdempotency(tenant, idempotencyKey) {
  if (!idempotencyKey) return null;
  return rowToAlarm(db.prepare('SELECT * FROM alarms WHERE tenant = ? AND idempotency_key = ?').get(tenant, idempotencyKey));
}
function saveAlarm(rec) {
  db.prepare(`INSERT OR REPLACE INTO alarms
    (id, tenant, text, alarm_json, enabled, next_trigger, idempotency_key, webhook_url, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(rec.id, rec.tenant, rec.text, JSON.stringify(rec.alarm), rec.enabled ? 1 : 0,
      rec.next_trigger || null, rec.idempotency_key || null, rec.webhook_url || null,
      rec.created_at, rec.updated_at);
}
function deleteAlarm(tenant, id) {
  return db.prepare('DELETE FROM alarms WHERE tenant = ? AND id = ?').run(tenant, id).changes > 0;
}
function getAllAlarms() {
  return db.prepare('SELECT * FROM alarms').all().map(rowToAlarm);
}

// ---------- 用量（滚动 30 天计费周期） ----------
function getUsage(key) {
  let r = db.prepare('SELECT * FROM usage WHERE key = ?').get(key);
  const now = Date.now();
  if (!r) {
    const period = new Date().toISOString();
    db.prepare('INSERT INTO usage (key, period_start) VALUES (?,?)').run(key, period);
    r = { key, parse_count: 0, alarm_create: 0, alarm_update: 0, alarm_delete: 0, fire_count: 0, period_start: period };
  } else {
    const start = new Date(r.period_start).getTime();
    if (now - start > QUOTA_WINDOW_MS) { // 周期滚动：清零并重置
      db.prepare('UPDATE usage SET parse_count=0, alarm_create=0, alarm_update=0, alarm_delete=0, fire_count=0, period_start=? WHERE key=?')
        .run(new Date().toISOString(), key);
      r = { ...r, parse_count: 0, alarm_create: 0, alarm_update: 0, alarm_delete: 0, fire_count: 0 };
    }
  }
  const plan = getKey(key);
  const quota = plan ? (PLANS[plan.plan] ? PLANS[plan.plan].monthly_parse_quota : null) : null;
  return { ...r, plan: plan ? plan.plan : 'free', quota, remaining: quota == null ? null : Math.max(0, quota - r.parse_count) };
}
function bumpUsage(key, field) {
  if (!key) return;
  const col = { parse_count: 'parse_count', alarm_create: 'alarm_create', alarm_update: 'alarm_update', alarm_delete: 'alarm_delete', fire_count: 'fire_count' }[field];
  if (!col) return;
  // 确保行存在
  if (!db.prepare('SELECT 1 FROM usage WHERE key = ?').get(key)) {
    db.prepare('INSERT INTO usage (key, period_start) VALUES (?,?)').run(key, new Date().toISOString());
  }
  db.prepare(`UPDATE usage SET ${col} = ${col} + 1 WHERE key = ?`).run(key);
}

// ---------- 参考 App（A 实现）本地数据：订阅 & 闹钟 ----------
function listSubs() {
  return db.prepare('SELECT * FROM subs').all().map(r => ({ id: r.id, subscription: JSON.parse(r.subscription_json) }));
}
// addSub（幂等）：相同订阅（同 endpoint）重复注册 → 返回既有 id，避免重建/重开浏览器后订阅行堆积。
// 签名由 (id, sub) 收敛为 (sub)（订阅主键 endpoint 即身份，行 id 由服务端生成），返回 { id, reused }。
function addSub(sub) {
  let s = sub;
  if (typeof sub === 'string') { try { s = JSON.parse(sub); } catch (e) { s = null; } }
  const endpoint = s && s.endpoint;
  if (endpoint) {
    const dup = db.prepare('SELECT * FROM subs').all().find(r => {
      try { return JSON.parse(r.subscription_json).endpoint === endpoint; } catch (e) { return false; }
    });
    if (dup) return { id: dup.id, reused: true };
  }
  const id = 'c' + Date.now() + Math.random().toString(36).slice(2, 7);
  db.prepare('INSERT INTO subs (id, subscription_json, created_at) VALUES (?,?,?)')
    .run(id, JSON.stringify(sub), new Date().toISOString());
  return { id, reused: false };
}
function deleteSub(id) { db.prepare('DELETE FROM subs WHERE id = ?').run(id); }
function listLegacyAlarms() {
  return db.prepare('SELECT * FROM legacy_alarms').all().map(r => ({
    id: r.id, clientId: r.client_id, subscription: r.subscription_json ? JSON.parse(r.subscription_json) : null,
    timestamp: r.timestamp, time: r.time, recurrence: r.recurrence, label: r.label,
    lead_minutes: r.lead_minutes || 0, end: r.end_json ? JSON.parse(r.end_json) : null,
    fired: !!r.fired, nextTrigger: r.next_trigger, fired_count: r.fired_count || 0,
    timezone: r.timezone || null,
    enabled: r.enabled === undefined ? true : !!r.enabled
  }));
}
function saveLegacyAlarm(a) {
  db.prepare(`INSERT OR REPLACE INTO legacy_alarms
    (id, client_id, subscription_json, timestamp, time, recurrence, label, lead_minutes, fired, next_trigger, end_json, fired_count, timezone, enabled)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(a.id, a.clientId, a.subscription ? JSON.stringify(a.subscription) : null, a.timestamp || 0,
      a.time, a.recurrence || 'none', a.label || '', a.lead_minutes || 0, a.fired ? 1 : 0, a.nextTrigger || 0,
      a.end ? JSON.stringify(a.end) : null, a.fired_count || 0, a.timezone || 'Asia/Shanghai', a.enabled !== false ? 1 : 0);
}
function deleteLegacyAlarm(clientId, id) {
  return db.prepare('DELETE FROM legacy_alarms WHERE client_id = ? AND id = ?').run(clientId, id).changes > 0;
}

// F1：单闹钟启停——按 clientId + id 更新 enabled；命中返回 true（changes>0），未命中返回 false。
function setLegacyAlarmEnabled(clientId, id, enabled) {
  const r = db.prepare('UPDATE legacy_alarms SET enabled = ? WHERE client_id = ? AND id = ?')
    .run(enabled ? 1 : 0, clientId, id);
  return r.changes > 0;
}

// ---------- 待投递队列（Webhook 持久化，支持崩溃恢复） ----------
const DELIVERY_MAX_ATTEMPTS = 8;
function enqueueDelivery({ tenant, url, body, sig }) {
  const id = 'd' + crypto.randomBytes(10).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO deliveries (id, tenant, url, body, sig, attempt, next_attempt, status, created_at) VALUES (?,?,?,?,?,0,?,?,?)')
    .run(id, tenant, url, body, sig, now, 'pending', new Date().toISOString());
  return id;
}
function getDueDeliveries(now) {
  return db.prepare("SELECT * FROM deliveries WHERE status='pending' AND next_attempt <= ? ORDER BY next_attempt ASC LIMIT 50").all(now);
}
// 原子抢占：仅当仍是 pending 才置为 processing（changes=1 才算抢到）。
// 同一条投递在跨 tick / 跨实例重复扫描时不会被双发。
function claimDelivery(id) {
  const r = db.prepare("UPDATE deliveries SET status='processing', updated_at=? WHERE id=? AND status='pending'").run(new Date().toISOString(), id);
  return r.changes === 1;
}
// 崩溃恢复：processing 行若超过 staleMs 未推进（进程被 kill 时未写回），回退为 pending 重试
function recoverStuckDeliveries(beforeMs) {
  const iso = new Date(beforeMs).toISOString();
  return db.prepare("UPDATE deliveries SET status='pending' WHERE status='processing' AND updated_at < ?").run(iso).changes;
}
// 终态清理：success/failed 且超过保留期的行删除，防止 deliveries 表无限膨胀
function pruneDeliveries(beforeMs) {
  const iso = new Date(beforeMs).toISOString();
  return db.prepare("DELETE FROM deliveries WHERE status IN ('success','failed') AND updated_at < ?").run(iso).changes;
}
function markDeliverySuccess(id) {
  db.prepare("UPDATE deliveries SET status='success', updated_at=? WHERE id=?").run(new Date().toISOString(), id);
}
function markDeliveryRetry(id, attempt, nextAttempt, error) {
  const status = attempt >= DELIVERY_MAX_ATTEMPTS ? 'failed' : 'pending';
  db.prepare("UPDATE deliveries SET attempt=?, next_attempt=?, status=?, last_error=?, updated_at=? WHERE id=?")
    .run(attempt, nextAttempt, status, error || null, new Date().toISOString(), id);
}

// ---------- 限流（持久化：重启不丢、同库多实例可共享 WAL） ----------
function recordRateEvent(rawKey, ts) {
  db.prepare('INSERT INTO rate_limits (key_hash, ts) VALUES (?,?)').run(hashKey(rawKey), ts);
}
function pruneRateEvents(rawKey, beforeMs) {
  db.prepare('DELETE FROM rate_limits WHERE key_hash = ? AND ts < ?').run(hashKey(rawKey), beforeMs);
}
function rateEventCount(rawKey, sinceMs) {
  return db.prepare('SELECT count(*) c FROM rate_limits WHERE key_hash = ? AND ts >= ?').get(hashKey(rawKey), sinceMs).c;
}
function oldestRateEvent(rawKey, sinceMs) {
  const r = db.prepare('SELECT min(ts) m FROM rate_limits WHERE key_hash = ? AND ts >= ?').get(hashKey(rawKey), sinceMs);
  return r && r.m ? r.m : null;
}
function checkRateLimit(rawKey, limit, windowMs) {
  const nowMs = Date.now();
  const since = nowMs - windowMs;
  pruneRateEvents(rawKey, since);
  const count = rateEventCount(rawKey, since);
  if (count >= limit) {
    const oldest = oldestRateEvent(rawKey, since) || nowMs;
    const retryAfter = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    return { allowed: false, retryAfter };
  }
  recordRateEvent(rawKey, nowMs);
  return { allowed: true };
}
function pruneStaleRateEvents(beforeMs) {
  db.prepare('DELETE FROM rate_limits WHERE ts < ?').run(beforeMs);
}

// ---------- 指标（可观测性：投递成功率 / 解析耗时 等） ----------
function incrMetric(name, delta) {
  const d = (typeof delta === 'number' && isFinite(delta)) ? delta : 1;
  db.prepare(`INSERT INTO metrics (name, value, updated_at) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET value = value + ?, updated_at = ?`)
    .run(name, d, new Date().toISOString(), d, new Date().toISOString());
}
function getMetrics() {
  const rows = db.prepare('SELECT name, value FROM metrics').all();
  const o = {};
  for (const r of rows) o[r.name] = r.value;
  return o;
}

// ---------- 旧版库结构迁移（明文 key 主键 → 哈希存储） ----------
function migrateKeysSchema() {
  const cols = db.prepare('PRAGMA table_info(keys)').all().map(c => c.name);
  if (cols.includes('key_hash')) return; // 已是新结构
  if (!cols.includes('key')) return;     // 全新库，无需迁移
  db.exec('ALTER TABLE keys RENAME TO keys_old');
  db.exec(`CREATE TABLE keys (
    key_hash TEXT PRIMARY KEY, key_enc TEXT NOT NULL, tenant TEXT NOT NULL, label TEXT,
    enabled INTEGER NOT NULL DEFAULT 1, rate_limit INTEGER, plan TEXT NOT NULL DEFAULT 'free',
    webhook_url TEXT, webhook_verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
  const rows = db.prepare('SELECT * FROM keys_old').all();
  const ins = db.prepare('INSERT INTO keys (key_hash, key_enc, tenant, label, enabled, rate_limit, plan, webhook_url, webhook_verified, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(hashKey(r.key), encryptSecret(r.key), r.tenant, r.label, r.enabled, r.rate_limit, r.plan, r.webhook_url, r.webhook_verified, r.created_at);
  db.exec('DROP TABLE keys_old');
  console.log('[db] 已迁移 keys 表至哈希存储（共 ' + rows.length + ' 枚）');
}

// deliveries 表补充 updated_at 列（崩溃恢复 + 终态清理依赖；旧库 ALTER 补齐）
function migrateDeliveriesSchema() {
  const cols = db.prepare('PRAGMA table_info(deliveries)').all().map(c => c.name);
  if (!cols.includes('updated_at')) {
    db.exec("ALTER TABLE deliveries ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
  }
}

// legacy_alarms 表补充 lead_minutes 列（重复闹钟「提前提醒」依赖）+ end_json/fired_count（结束条件依赖）；旧库 ALTER 补齐
function migrateLegacyAlarmsSchema() {
  const cols = db.prepare('PRAGMA table_info(legacy_alarms)').all().map(c => c.name);
  if (!cols.includes('lead_minutes')) {
    db.exec('ALTER TABLE legacy_alarms ADD COLUMN lead_minutes INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('end_json')) {
    db.exec('ALTER TABLE legacy_alarms ADD COLUMN end_json TEXT');
  }
  if (!cols.includes('fired_count')) {
    db.exec('ALTER TABLE legacy_alarms ADD COLUMN fired_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('timezone')) {
    db.exec("ALTER TABLE legacy_alarms ADD COLUMN timezone TEXT DEFAULT 'Asia/Shanghai'");
  }
}

// legacy_alarms 表补充 enabled 列（F1：单闹钟启停，默认启用）。旧库 ALTER 补齐，幂等。
function migrateLegacyAlarmsEnabled() {
  const cols = db.prepare('PRAGMA table_info(legacy_alarms)').all().map(c => c.name);
  if (!cols.includes('enabled')) {
    db.exec('ALTER TABLE legacy_alarms ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
  }
}

// keys 表补充 default_timezone 列（租户级默认时区，P3-P1-3）。旧库 ALTER 补齐，幂等。
function migrateKeysDefaultTz() {
  const cols = db.prepare('PRAGMA table_info(keys)').all().map(c => c.name);
  if (!cols.includes('default_timezone')) {
    db.exec("ALTER TABLE keys ADD COLUMN default_timezone TEXT DEFAULT 'Asia/Shanghai'");
  }
}

// ---------- 首启：从旧 JSON 迁移 ----------
function migrateFromJson() {
  const count = db.prepare('SELECT count(*) c FROM keys').get().c;
  if (count > 0) return; // 已迁移过（含 migrateKeysSchema 的库内迁移）
  let migrated = { keys: 0, alarms: 0, usage: 0 };
  // keys.json
  const kp = path.join(DATA, 'keys.json');
  if (fs.existsSync(kp)) {
    try {
      const arr = JSON.parse(fs.readFileSync(kp, 'utf8'));
      const ins = db.prepare('INSERT OR IGNORE INTO keys (key_hash, key_enc, tenant, label, enabled, rate_limit, plan, webhook_url, webhook_verified, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const k of arr) {
        const plan = PLANS[k.plan] ? k.plan : DEFAULT_PLAN;
        const raw = k.key;
        ins.run(hashKey(raw), encryptSecret(raw), k.tenant || 'demo', k.label || '', k.enabled === false ? 0 : 1,
          k.rate_limit || PLANS[plan].rate_limit, plan, k.webhook_url || null, k.webhook_verified ? 1 : 0,
          k.created_at || new Date().toISOString());
        migrated.keys++;
      }
    } catch (e) { console.warn('[db] keys.json 迁移失败', e.message); }
  }
  // alarms.json
  const ap = path.join(DATA, 'alarms.json');
  if (fs.existsSync(ap)) {
    try {
      const obj = JSON.parse(fs.readFileSync(ap, 'utf8'));
      const ins = db.prepare('INSERT OR IGNORE INTO alarms (id, tenant, text, alarm_json, enabled, next_trigger, idempotency_key, webhook_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
      for (const tenant in obj) {
        for (const a of (obj[tenant] || [])) {
          ins.run(a.id, tenant, a.text || null, JSON.stringify(a.alarm), a.enabled === false ? 0 : 1,
            a.next_trigger || null, a.idempotency_key || null, a.webhook_url || null,
            a.created_at || new Date().toISOString(), a.updated_at || new Date().toISOString());
          migrated.alarms++;
        }
      }
    } catch (e) { console.warn('[db] alarms.json 迁移失败', e.message); }
  }
  // usage.json
  const up = path.join(DATA, 'usage.json');
  if (fs.existsSync(up)) {
    try {
      const obj = JSON.parse(fs.readFileSync(up, 'utf8'));
      const ins = db.prepare('INSERT OR IGNORE INTO usage (key, parse_count, alarm_create, alarm_update, alarm_delete, fire_count, period_start) VALUES (?,?,?,?,?,?,?)');
      for (const k in obj) {
        const u = obj[k];
        ins.run(k, u.parse_count || 0, u.alarm_create || 0, u.alarm_update || 0, u.alarm_delete || 0, u.fire_count || 0, u.since || new Date().toISOString());
        migrated.usage++;
      }
    } catch (e) { console.warn('[db] usage.json 迁移失败', e.message); }
  }
  // store.json（参考 App 的订阅 + 本地闹钟）
  const sp = path.join(DATA, 'store.json');
  if (fs.existsSync(sp)) {
    try {
      const s = JSON.parse(fs.readFileSync(sp, 'utf8'));
      const insSub = db.prepare('INSERT OR IGNORE INTO subs (id, subscription_json, created_at) VALUES (?,?,?)');
      for (const id in (s.subs || {})) insSub.run(id, JSON.stringify(s.subs[id].subscription), new Date(s.subs[id].createdAt || Date.now()).toISOString());
      const insA = db.prepare('INSERT OR IGNORE INTO legacy_alarms (id, client_id, subscription_json, timestamp, time, recurrence, label, fired, next_trigger, end_json, fired_count) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
      for (const a of (s.alarms || [])) insA.run(a.id, a.clientId, a.subscription ? JSON.stringify(a.subscription) : null, a.timestamp || 0, a.time, a.recurrence || 'none', a.label || '', a.fired ? 1 : 0, a.nextTrigger || 0, null, 0);
      migrated.store = (Object.keys(s.subs || {}).length) + (s.alarms || []).length;
    } catch (e) { console.warn('[db] store.json 迁移失败', e.message); }
  }
  if (migrated.keys || migrated.alarms || migrated.usage)
    console.log('[db] 已从旧 JSON 迁移：', JSON.stringify(migrated));
}
migrateFromJson();

// 若库中仍无密钥（全新部署），自动生成一枚示例密钥便于立即体验
// 仅平台模式生成 demo 租户示例密钥；单用户模式下不生成，由 ensureSingleUserKey 提供内置密钥
if (PLATFORM_MODE) {
  if (db.prepare('SELECT count(*) c FROM keys').get().c === 0) {
    const sample = createKey({ tenant: 'demo', label: '示例密钥（自动生成）', plan: 'free' });
    console.log('[db] 已生成示例 API Key（data/alarm.db）：', sample.key);
    console.log('[db] 管理：node manage_keys.js create/list/disable/enable');
  }
}

module.exports = {
  db, PLANS, DEFAULT_PLAN, QUOTA_WINDOW_MS, DELIVERY_MAX_ATTEMPTS,
  PLATFORM_MODE, SINGLE_USER_KEY, ensureSingleUserKey,
  getKey, listKeys, listAllKeys, getEnabledKeyForTenant, createKey, setKeyEnabled, setWebhook,
  getAlarmsByTenant, getAlarm, findAlarmByIdempotency, saveAlarm, deleteAlarm, getAllAlarms,
  getUsage, bumpUsage,
  checkRateLimit, pruneStaleRateEvents, incrMetric, getMetrics,
  enqueueDelivery, getDueDeliveries, claimDelivery, recoverStuckDeliveries, pruneDeliveries, markDeliverySuccess, markDeliveryRetry,
  listSubs, addSub, deleteSub, listLegacyAlarms, saveLegacyAlarm, deleteLegacyAlarm, setLegacyAlarmEnabled
};
