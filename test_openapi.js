'use strict';
/*
 * test_openapi.js — 开放 API 集成测试
 * 启动 server.js 子进程（独立端口），覆盖：
 *   health 200 / 缺 key→401 / 错误 key→401 / 缺 text→400 /
 *   解析成功(source=rule,request_id) / 模糊输入→clarification /
 *   now 覆盖确定性 / 限流→429
 * 测试前后自动备份/恢复 data/keys.json，不破坏用户既有密钥。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DATA = path.join(__dirname, 'data');
// 测试使用独立的 test.alarm.db（通过 ALARM_DB 环境变量），完全不触碰用户既有 data/alarm.db 与 keys.json
const TEST_DB = path.join(DATA, 'test.alarm.db');
const TEST_DB_FILES = ['test.alarm.db', 'test.alarm.db-wal', 'test.alarm.db-shm'];
// 测试前清掉上一次遗留的测试库，避免脏数据
TEST_DB_FILES.forEach(f => { const p = path.join(DATA, f); if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) {} } });
process.env.ALARM_DB = TEST_DB;

// 用 db.js（指向 test.alarm.db）初始化一份全新库，并注入测试密钥（多租户，用于隔离验证 + 限流验证）
const db = require('./db.js');
const { computeNext } = require('./scheduler.js');
db.db.prepare('DELETE FROM keys').run(); // 清空（含示例/迁移密钥），仅保留下列测试密钥
const kN = db.createKey({ tenant: 'testA', label: 'normal', rate_limit: 100, plan: 'free' });
const kO = db.createKey({ tenant: 'testB', label: 'other', rate_limit: 100, plan: 'free' });
const kR = db.createKey({ tenant: 'testA', label: 'rate', rate_limit: 3, plan: 'free' });
const NORMAL_KEY = kN.key;   // tenant: testA
const OTHER_KEY = kO.key;    // tenant: testB（隔离验证）
const RATE_KEY = kR.key;     // tenant: testA（rate_limit=3）

const PORT = 8099;
// P1-3 测试需要：为独立租户预置服务端级默认时区（仅该租户生效，不影响既有 testA/testB 基线）。
// 必须在 spawn 前设置，使子进程继承该环境变量。
process.env['ALARM_DEFAULT_TZ_testTZenv'] = 'America/Chicago';

const srv = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT), ALARM_DB: TEST_DB }, cwd: __dirname });
srv.stderr.on('data', d => process.stderr.write('[server] ' + d));

// 本地 Webhook 接收端（用于验证触发投递 + 验签）
const RECEIVER_PORT = 8091;
const received = [];
const receiver = http.createServer((rq, rs) => {
  let b = ''; rq.on('data', c => b += c);
  rq.on('end', () => { received.push({ event: rq.headers['x-alarm-event'], sig: rq.headers['x-alarm-signature'], body: b }); rs.writeHead(200); rs.end('ok'); });
});
receiver.listen(RECEIVER_PORT);

// 失败接收端：恒返回 500，用于验证 Webhook 投递的退避重试（而非标记成功/双发）
const RECEIVER_FAIL_PORT = 8092;
const failReceiver = http.createServer((rq, rs) => { rq.resume(); rs.writeHead(500); rs.end('err'); });
failReceiver.listen(RECEIVER_FAIL_PORT);

function pad(n) { return String(n).padStart(2, '0'); }
function localYMD(dt) { return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()); }
function localHM(dt) { return pad(dt.getHours()) + ':' + pad(dt.getMinutes()); }
function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => { if (cond()) return resolve(true); if (Date.now() - t0 > timeoutMs) return resolve(false); setTimeout(tick, 200); };
    tick();
  });
}

function reqOn(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: 'localhost', port, method, path: p, headers: headers || {} }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    // 套接字错误（如服务端在读取超大 body 时中断连接）不抛出，避免中断整个测试；以 status:0 表示连接异常
    r.on('error', () => resolve({ status: 0, headers: {}, body: '', error: true }));
    if (body) r.write(body);
    r.end();
  });
}
const req = (method, p, headers, body) => reqOn(PORT, method, p, headers, body);
const req2 = (method, p, headers, body) => reqOn(PORT + 1, method, p, headers, body);

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

(async () => {
  // 等待就绪
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const h = await req('GET', '/v1/health', {}); if (h.status === 200) { ready = true; break; } } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) { console.log('server 未就绪，中止'); await cleanup(); process.exit(1); }

  console.log('— 开放 API 集成测试 —');
  let h = await req('GET', '/v1/health', {});
  assert(h.status === 200 && JSON.parse(h.body).status === 'ok', 'GET /v1/health → 200 {status:ok}', h.status);

  // 指标空值边界：在尚未发生任何解析/投递的「全新」测试库上，派生量应为安全默认（非 NaN）
  let m0 = await req('GET', '/v1/metrics', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  let m0j = JSON.parse(m0.body);
  assert(m0.status === 200 && m0j.derived.parse_avg_latency_ms === 0 && m0j.derived.delivery_success_rate === null, 'GET /v1/metrics 空库边界：avg_latency=0, success_rate=null（非 NaN）', JSON.stringify(m0j.derived));

  let p = await req('POST', '/v1/parse', {}, JSON.stringify({ text: '明天早上8点叫我起床' }));
  assert(p.status === 401, 'POST /v1/parse 无 Key → 401', p.status);

  p = await req('POST', '/v1/parse', { Authorization: 'Bearer wrong' }, JSON.stringify({ text: 'x' }));
  assert(p.status === 401, 'POST /v1/parse 错误 Key → 401', p.status);

  p = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({}));
  assert(p.status === 400, 'POST /v1/parse 缺 text → 400', p.status);

  p = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: 'a'.repeat(201) }));
  assert(p.status === 400, 'POST /v1/parse text 超 200 字 → 400', p.status);

  p = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天早上8点叫我起床' }));
  let j = JSON.parse(p.body);
  assert(p.status === 200 && j.success === true, 'POST /v1/parse 成功 → 200 success', p.status);
  assert(j.source === 'rule', '响应含 source=rule');
  assert(typeof j.request_id === 'string' && j.request_id.startsWith('req_'), '响应含 request_id');
  assert(j.alarm && j.alarm.time === '08:00', '解析 time=08:00', JSON.stringify(j.alarm));

  p = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '待会提醒我喝水' }));
  j = JSON.parse(p.body);
  assert(p.status === 200 && j.success === false && j.needs_clarification === true, '模糊输入 → 200 需澄清');
  assert(j.clarification && Array.isArray(j.clarification.suggestions) && j.clarification.suggestions.length === 4, '含 clarification.suggestions(4)');

  // now 覆盖确定性：固定基准时间，验证「明天」稳定
  p = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天8点开会', now: '2026-10-09T12:00:00+08:00' }));
  j = JSON.parse(p.body);
  assert(j.success && j.alarm.date === '2026-10-10' && j.alarm.time === '08:00', 'now 覆盖：明天=2026-10-10 08:00', JSON.stringify(j.alarm));

  // P0-3：/v1/parse 透传 timezone（IANA），墙钟保持 08:00，datetime 含正确偏移；非法 IANA → 400 invalid_timezone
  let pTz = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天8点开会', timezone: 'America/New_York' }));
  let pTzj = JSON.parse(pTz.body);
  assert(pTz.status === 200 && pTzj.success && pTzj.alarm.time === '08:00' && pTzj.alarm.timezone === 'America/New_York', 'P0-3 /v1/parse 透传 timezone=America/New_York（墙钟 08:00 不漂移）', JSON.stringify(pTzj.alarm));
  assert(/[+-]\d{2}:\d{2}$/.test(pTzj.alarm.datetime), 'P0-3 datetime 含 IANA 时区偏移', pTzj.alarm.datetime);

  let pBad = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天8点开会', timezone: 'Foo/Bar' }));
  let pBadj = JSON.parse(pBad.body);
  assert(pBad.status === 400 && pBadj.error && pBadj.error.code === 'invalid_timezone', 'P0-3 非法 timezone=Foo/Bar → 400 invalid_timezone', pBad.status + ' ' + pBad.body);

  // 决策②闭环：空串/纯空白视为缺失 → 回退上海（非 400）
  let pEmpty = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天8点开会', timezone: '' }));
  let pEmptyj = JSON.parse(pEmpty.body);
  assert(pEmpty.status === 200 && pEmptyj.success && pEmptyj.alarm.timezone === 'Asia/Shanghai', 'P0-3 空串 timezone="" → 200 回退上海（非 400）', pEmpty.status + ' ' + JSON.stringify(pEmptyj.alarm));
  let pWs = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天8点开会', timezone: '   ' }));
  let pWsj = JSON.parse(pWs.body);
  assert(pWs.status === 200 && pWsj.success && pWsj.alarm.timezone === 'Asia/Shanghai', 'P0-3 纯空白 timezone="   " → 200 回退上海（非 400）', pWs.status + ' ' + JSON.stringify(pWsj.alarm));

  // 限流：用 rate_limit=3 的 key 连续发 5 次，后两次应 429
  let got429 = false, okCount = 0;
  for (let i = 0; i < 5; i++) {
    const r = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + RATE_KEY }, JSON.stringify({ text: '30分钟后提醒' }));
    if (r.status === 429) got429 = true; else if (r.status === 200) okCount++;
  }
  assert(got429, '触发限流 → 至少一次 429');
  assert(okCount === 3, '限流前恰好放行 3 次（rate_limit=3）', 'okCount=' + okCount);

  // ---------- 托管闹钟 CRUD + 租户隔离 ----------
  console.log('— 托管闹钟 CRUD —');
  // 创建（自然语言）
  let c = await req('POST', '/v1/alarms', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天早上8点叫我起床', idempotency_key: 'idemp-1' }));
  let cj = JSON.parse(c.body);
  assert(c.status === 201 && cj.id && cj.alarm && cj.alarm.time === '08:00', 'POST /v1/alarms(自然语言) → 201', c.status);
  const alarmId = cj.id;

  // 幂等：同 idempotency_key 重复提交返回已有记录（HTTP 200，未新建）
  let c2 = await req('POST', '/v1/alarms', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天早上8点叫我起床', idempotency_key: 'idemp-1' }));
  let c2j = JSON.parse(c2.body);
  assert(c2.status === 200 && c2j.idempotent === true && c2j.id === alarmId, '幂等：重复 idempotency_key → 200 返回已有记录', c2.status);

  // 显式时间创建（每周一9点）
  let ce = await req('POST', '/v1/alarms', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ time: '09:00', recurrence: 'weekly:1', label: '周会' }));
  let cej = JSON.parse(ce.body);
  assert(ce.status === 201 && cej.alarm.recurrence === 'weekly:1' && cej.alarm.time === '09:00', 'POST /v1/alarms(显式时间) → 201', ce.status);
  assert(typeof cej.next_trigger === 'number' && cej.next_trigger > Date.now(), '显式重复闹钟含未来 next_trigger', JSON.stringify(cej.next_trigger));

  // 缺少 text/time → 400
  let cb = await req('POST', '/v1/alarms', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ label: '无时间' }));
  assert(cb.status === 400, 'POST /v1/alarms 缺时间字段 → 400', cb.status);

  // 模糊输入 → 422 + clarification
  let cv = await req('POST', '/v1/alarms', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '待会提醒我喝水' }));
  let cvj = JSON.parse(cv.body);
  assert(cv.status === 422 && cvj.needs_clarification === true && cvj.clarification, 'POST /v1/alarms 模糊输入 → 422 + clarification', cv.status);

  // 列表
  let l = await req('GET', '/v1/alarms', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  let lj = JSON.parse(l.body);
  assert(l.status === 200 && lj.count >= 2 && Array.isArray(lj.alarms), 'GET /v1/alarms → 200 列表', l.status);
  assert(lj.alarms.every(x => x.tenant === 'testA'), '列表仅含当前租户(testA)记录', JSON.stringify(lj.alarms.map(x => x.tenant)));

  // 按 id 获取
  let g = await req('GET', '/v1/alarms/' + alarmId, { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  assert(g.status === 200 && JSON.parse(g.body).id === alarmId, 'GET /v1/alarms/:id → 200', g.status);

  // 不存在 → 404
  let gn = await req('GET', '/v1/alarms/nope', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  assert(gn.status === 404, 'GET /v1/alarms/nope → 404', gn.status);

  // 更新（禁用）
  let u = await req('PATCH', '/v1/alarms/' + alarmId, { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ enabled: false }));
  let uj = JSON.parse(u.body);
  assert(u.status === 200 && uj.enabled === false, 'PATCH /v1/alarms/:id 禁用 → 200', u.status);

  // 更新（自然语言重解析）
  let u2 = await req('PATCH', '/v1/alarms/' + alarmId, { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '后天上午10点吃药' }));
  let u2j = JSON.parse(u2.body);
  assert(u2.status === 200 && u2j.alarm && /10:00/.test(u2j.alarm.time), 'PATCH /v1/alarms/:id 改自然语言 → 200 重解析', JSON.stringify(u2j.alarm));

  // 删除
  let d = await req('DELETE', '/v1/alarms/' + alarmId, { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  assert(d.status === 200 && JSON.parse(d.body).ok === true, 'DELETE /v1/alarms/:id → 200', d.status);
  let gd = await req('GET', '/v1/alarms/' + alarmId, { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  assert(gd.status === 404, '删除后再次 GET → 404', gd.status);

  // 租户隔离：testB 看不到 testA 的闹钟
  let lb = await req('GET', '/v1/alarms', { Authorization: 'Bearer ' + OTHER_KEY }, null);
  let lbj = JSON.parse(lb.body);
  assert(lb.status === 200 && lbj.alarms.every(x => x.tenant === 'testB'), '租户隔离：OTHER_KEY 仅见 testB 记录', JSON.stringify(lbj.alarms.map(x => x.tenant)));
  let gb = await req('GET', '/v1/alarms/' + alarmId, { Authorization: 'Bearer ' + OTHER_KEY }, null);
  assert(gb.status === 404, '租户隔离：OTHER_KEY 访问 testA 闹钟 → 404', gb.status);

  // ---------- Webhook 配置 + 触发投递 + 用量计量（Phase 3） ----------
  console.log('— Webhook & 用量 —');
  let wh0 = await req('GET', '/v1/webhook', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  assert(wh0.status === 200 && JSON.parse(wh0.body).url === null, 'GET /v1/webhook 初始 → url=null', wh0.status);

  let whs = await req('POST', '/v1/webhook', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ url: 'https://example.com/alarm-hook' }));
  let whsj = JSON.parse(whs.body);
  assert(whs.status === 200 && whsj.url === 'https://example.com/alarm-hook' && typeof whsj.verified === 'boolean', 'POST /v1/webhook 设置 https → 200 已存储', whs.status);

  let whl = await req('POST', '/v1/webhook', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ url: 'http://localhost:' + RECEIVER_PORT }));
  let whlj = JSON.parse(whl.body);
  assert(whl.status === 200 && whlj.url === 'http://localhost:' + RECEIVER_PORT && whlj.verified === true, 'POST /v1/webhook 设置 localhost → 200 且 verified=true', whl.status);

  let whg = await req('GET', '/v1/webhook', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  assert(whg.status === 200 && JSON.parse(whg.body).url === 'http://localhost:' + RECEIVER_PORT, 'GET /v1/webhook → 返回已设置地址', whg.status);

  // 非法协议 → 400
  let whb = await req('POST', '/v1/webhook', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ url: 'ftp://x' }));
  assert(whb.status === 400, 'POST /v1/webhook 非法协议 → 400', whb.status);

  // 触发投递：创建一条过去时间的闹钟 → 调度器立即触发 → 推送 alarm.fired 到接收端
  const past = new Date(Date.now() - 120000);
  let fire = await req('POST', '/v1/alarms', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ date: localYMD(past), time: localHM(past), recurrence: 'none', label: 'webhook-trigger' }));
  let firej = JSON.parse(fire.body);
  assert(fire.status === 201 && firej.id, '触发测试：创建过去时间闹钟 → 201', fire.status);
  const fireId = firej.id;

  const got = await waitFor(() => received.find(x => JSON.parse(x.body).alarm_id === fireId), 5000);
  assert(got, '过去时间闹钟被调度器触发并投递到 Webhook', 'received=' + received.length);
  if (got) {
    const ev = received.find(x => JSON.parse(x.body).alarm_id === fireId);
    assert(ev.event === 'alarm.fired', '投递事件 event=alarm.fired');
    const expected = 'sha256=' + crypto.createHmac('sha256', NORMAL_KEY).update(ev.body).digest('hex');
    const sigOk = (ev.sig === expected) || (crypto.timingSafeEqual(Buffer.from(ev.sig), Buffer.from(expected)));
    assert(sigOk, 'Webhook 签名可经 API Key 验签（HMAC-SHA256）', ev.sig);
  }
  // 清理该闹钟
  await req('DELETE', '/v1/alarms/' + fireId, { Authorization: 'Bearer ' + NORMAL_KEY }, null);

  // 用量计量
  let us = await req('GET', '/v1/usage', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  let usj = JSON.parse(us.body);
  assert(us.status === 200 && usj.usage && typeof usj.usage.parse_count === 'number', 'GET /v1/usage → 200 含用量对象', us.status);
  assert(usj.usage.parse_count >= 1, 'parse_count ≥ 1（解析接口被调用过）', 'parse_count=' + usj.usage.parse_count);
  assert(usj.usage.fire_count >= 1, 'fire_count ≥ 1（触发投递发生过）', 'fire_count=' + usj.usage.fire_count);

  // 指标端点（可观测性）
  let mt = await req('GET', '/v1/metrics', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  let mtj = JSON.parse(mt.body);
  assert(mt.status === 200 && mtj.metrics && typeof mtj.metrics.parse_total === 'number' && mtj.derived && typeof mtj.derived.parse_avg_latency_ms === 'number', 'GET /v1/metrics → 200 含聚合指标与派生量', mt.status);

  // 投递原子抢占：同一条 pending 只会被 claim 一次（防跨 tick / 跨实例双发）
  const claimId = db.enqueueDelivery({ tenant: 'testA', url: 'http://localhost:' + RECEIVER_PORT, body: '{}', sig: 'x' });
  const firstClaim = db.claimDelivery(claimId);
  const secondClaim = db.claimDelivery(claimId);
  assert(firstClaim === true && secondClaim === false, '投递原子抢占：同一条仅可被 claim 一次（防双发）', 'first=' + firstClaim + ' second=' + secondClaim);
  db.markDeliverySuccess(claimId); // 结算，避免 worker 后续无效重试

  // 崩溃恢复：直接写入一条「已存在」的 pending 投递，验证 worker 会续传处理（进程重启后同理）
  const recId = 'recovery-' + Date.now();
  const recBody = JSON.stringify({ event: 'alarm.fired', alarm_id: recId, tenant: 'testA', text: 'recovery', alarm: { time: '08:00' }, fired_at: new Date().toISOString() });
  const recSig = 'sha256=' + crypto.createHmac('sha256', NORMAL_KEY).update(recBody).digest('hex');
  db.enqueueDelivery({ tenant: 'testA', url: 'http://localhost:' + RECEIVER_PORT, body: recBody, sig: recSig });
  const recGot = await waitFor(() => received.find(x => JSON.parse(x.body).alarm_id === recId), 5000);
  assert(recGot, '崩溃恢复：预存 pending 投递被 worker 续传送达', 'received=' + received.length);

  // 调度器：recurring(daily) 闹钟到点触发并重排到未来（验证 next_trigger 推进逻辑）
  const schedId = 'sched-' + Date.now();
  db.db.prepare(`INSERT INTO alarms (id,tenant,text,alarm_json,enabled,next_trigger,idempotency_key,webhook_url,created_at,updated_at)
    VALUES (?,?,?,?,1,?,NULL,NULL,?,?)`).run(
    schedId, 'testA', 'daily-rearm', JSON.stringify({ time: '08:00', recurrence: 'daily', timezone: 'Asia/Shanghai', label: 'sched', timestamp: Math.floor(Date.now() / 1000) }),
    Date.now() - 5000, new Date().toISOString(), new Date().toISOString());
  const rearmed = await waitFor(() => { const a = db.getAlarm('testA', schedId); return a && a.next_trigger && a.next_trigger > Date.now(); }, 5000);
  assert(rearmed, '调度器：recurring(daily) 到点触发并重排到未来 next_trigger', 'schedId=' + schedId);
  await req('DELETE', '/v1/alarms/' + schedId, { Authorization: 'Bearer ' + NORMAL_KEY }, null);

  // 重复 + 提前提醒：daily 带 lead_minutes，next_trigger 应为「墙钟 - lead」（修复此前重复闹钟提前提醒失效）
  const leadId = 'lead-' + Date.now();
  const leadReq = await req('POST', '/v1/alarms', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ time: '07:45', recurrence: 'daily', lead_minutes: 30, label: 'lead-test', idempotency_key: leadId }));
  const leadj = JSON.parse(leadReq.body);
  assert(leadReq.status === 201 && leadj.alarm.lead_minutes === 30, 'POST /v1/alarms(daily+lead_minutes) → 201 且 lead_minutes=30', leadReq.status);
  const wall = computeNext('07:45', 'daily', Date.now(), 'Asia/Shanghai');
  assert(Math.abs(leadj.next_trigger - (wall - 30 * 60000)) < 2000, 'daily+lead: next_trigger = 墙钟 - 30min（提前提醒生效）', JSON.stringify({ got: leadj.next_trigger, exp: wall - 1800000 }));
  await req('DELETE', '/v1/alarms/' + leadj.id, { Authorization: 'Bearer ' + NORMAL_KEY }, null);

  // P0-4：/api/alarm 持久化 timezone，且重复闹钟触发后按该时区（America/New_York）重排 nextTrigger
  const apiClientId = 'tzclient-' + Date.now();
  const legacyId = 'tzlegacy-' + Date.now();
  const pastTs = Math.floor((Date.now() - 60000) / 1000); // 1 分钟前 → nextTrigger 在过去，fire-loop 立即可触发并重排
  let apiAlarm = await req('POST', '/api/alarm', {}, JSON.stringify({
    clientId: apiClientId, id: legacyId, time: '08:00', recurrence: 'daily', timezone: 'America/New_York', timestamp: pastTs, label: 'ny-daily'
  }));
  assert(apiAlarm.status === 200 && JSON.parse(apiAlarm.body).ok === true, 'P0-4 POST /api/alarm → 200 ok', apiAlarm.status);

  const leg = db.listLegacyAlarms().find(x => x.clientId === apiClientId);
  assert(leg && leg.timezone === 'America/New_York', 'P0-4 遗留闹钟持久化 timezone=America/New_York', JSON.stringify(leg));

  const reArmed = await waitFor(() => {
    const a = db.listLegacyAlarms().find(x => x.clientId === apiClientId);
    return a && a.nextTrigger && a.nextTrigger > Date.now();
  }, 5000);
  assert(reArmed, 'P0-4 重复闹钟触发后按 America/New_York 重排到未来 nextTrigger', 'clientId=' + apiClientId);
  if (reArmed) {
    const a = db.listLegacyAlarms().find(x => x.clientId === apiClientId);
    const exp = computeNext('08:00', 'daily', pastTs * 1000, 'America/New_York');
    assert(Math.abs(a.nextTrigger - exp) < 2000, 'P0-4 nextTrigger 与 scheduler.computeNext(America/New_York) 一致', JSON.stringify({ got: a.nextTrigger, exp }));
  }
  await req('POST', '/api/alarm/remove', {}, JSON.stringify({ clientId: apiClientId, id: legacyId }));

  // 投递退避：失败(500)的 Webhook 进入重试（attempt 递增、不误标成功、不双发）
  const dFailId = db.enqueueDelivery({ tenant: 'testA', url: 'http://localhost:' + RECEIVER_FAIL_PORT, body: '{}', sig: 'x' });
  const retried = await waitFor(() => {
    const row = db.db.prepare('SELECT * FROM deliveries WHERE id=?').get(dFailId);
    return row && row.attempt >= 1 && row.status !== 'success';
  }, 5000);
  const failRow = db.db.prepare('SELECT * FROM deliveries WHERE id=?').get(dFailId);
  assert(retried, '投递退避：失败(500)后进入重试（attempt≥1 且非 success）', JSON.stringify(failRow));
  assert(failRow && failRow.status !== 'success', '投递退避：失败投递未误标 success', JSON.stringify(failRow));

  // 请求体上限：超大 body(>64KB) 应被拒（413），防止内存耗尽
  const bigBody = JSON.stringify({ text: 'a'.repeat(70000) });
  const tooBig = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, bigBody);
  assert(tooBig.status === 413, 'POST /v1/parse 超 64KB 请求体 → 413 payload_too_large', tooBig.status);

  // 清空 webhook
  let whc = await req('POST', '/v1/webhook', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ url: '' }));
  assert(whc.status === 200 && JSON.parse(whc.body).url === null, 'POST /v1/webhook 清空 → url=null', whc.status);

  // ---------- 开发者门户 + 密钥自助管理（Phase 4） ----------
  console.log('— 门户 & 密钥管理 —');
  let portal = await req('GET', '/portal', {});
  assert(portal.status === 200 && /开发者门户/.test(portal.body), 'GET /portal → 200 开发者门户页面', portal.status);

  let kl = await req('GET', '/v1/keys', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  let klj = JSON.parse(kl.body);
  assert(klj.status !== 401 && klj.count === 2, 'GET /v1/keys → 200 列出本租户 2 枚（NORMAL+RATE 同属 testA）', JSON.stringify(klj));
  assert(klj.keys.every(k => k.tenant === 'testA' && /…/.test(k.key)), '列表仅本租户且 Key 已脱敏', JSON.stringify(klj.keys && klj.keys.map(k => k.key)));

  let kc = await req('POST', '/v1/keys', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ label: '测试子密钥', plan: 'pro' }));
  let kcj = JSON.parse(kc.body);
  assert(kc.status === 201 && kcj.key && kcj.key.startsWith('sk_live_') && kcj.plan === 'pro' && kcj.rate_limit === 600, 'POST /v1/keys 创建 pro → 201 完整 Key(plan=pro,rate=600)', kc.status);
  const newKey = kcj.key;

  let kl2 = await req('GET', '/v1/keys', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  assert(JSON.parse(kl2.body).count === 3, '创建后列表 count=3', kl2.body);

  // 密钥启用/禁用
  let kd = await req('POST', '/v1/keys/' + newKey + '/disable', { Authorization: 'Bearer ' + NORMAL_KEY }, null);
  assert(kd.status === 200 && JSON.parse(kd.body).enabled === false, 'POST /v1/keys/:key/disable → 200', kd.status);
  let kd2 = await req('POST', '/v1/keys/' + newKey + '/disable', { Authorization: 'Bearer ' + OTHER_KEY }, null);
  assert(kd2.status === 404, '禁用不属于本租户的密钥 → 404', kd2.status);

  // P1-3：时区回退链 —— 租户 default_timezone > ALARM_DEFAULT_TZ_<tenant> 环境变量 > Asia/Shanghai
  // (a) 密钥携带 default_timezone：解析缺 timezone 时回退到它
  let dtz = await req('POST', '/v1/keys', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ label: '默认时区密钥', plan: 'free', default_timezone: 'Europe/Paris' }));
  let dtzj = JSON.parse(dtz.body);
  assert(dtz.status === 201 && dtzj.default_timezone === 'Europe/Paris', 'P1-3 创建密钥带 default_timezone → 201', JSON.stringify(dtzj));
  let pDtz = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + dtzj.key }, JSON.stringify({ text: '明天8点开会' }));
  let pDtzj = JSON.parse(pDtz.body);
  assert(pDtz.status === 200 && pDtzj.alarm && pDtzj.alarm.timezone === 'Europe/Paris' && pDtzj.alarm.time === '08:00', 'P1-3 缺 timezone 回退到租户 default_timezone=Europe/Paris', JSON.stringify(pDtzj.alarm));

  // (b) 环境变量 ALARM_DEFAULT_TZ_<tenant>：该租户密钥无 default_timezone 时回退到它（独立租户，避免污染基线）
  const envKey = db.createKey({ tenant: 'testTZenv', label: 'env-tz', rate_limit: 100, plan: 'free' });
  let pEnv = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + envKey.key }, JSON.stringify({ text: '明天8点开会' }));
  let pEnvj = JSON.parse(pEnv.body);
  assert(pEnv.status === 200 && pEnvj.alarm && pEnvj.alarm.timezone === 'America/Chicago' && pEnvj.alarm.time === '08:00', 'P1-3 缺 timezone 回退到 ALARM_DEFAULT_TZ_testTZenv=America/Chicago', JSON.stringify(pEnvj.alarm));

  // (c) 显式 timezone 优先于一切回退
  let pEx = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + dtzj.key }, JSON.stringify({ text: '明天8点开会', timezone: 'Asia/Tokyo' }));
  let pExj = JSON.parse(pEx.body);
  assert(pEx.status === 200 && pExj.alarm && pExj.alarm.timezone === 'Asia/Tokyo', 'P1-3 显式 timezone 优先于 default_timezone', JSON.stringify(pExj.alarm));

  // 租户隔离：OTHER_KEY 看不到 NORMAL 的密钥
  let klo = await req('GET', '/v1/keys', { Authorization: 'Bearer ' + OTHER_KEY }, null);
  let kloj = JSON.parse(klo.body);
  assert(kloj.count === 1 && kloj.keys[0].tenant === 'testB', '密钥隔离：OTHER_KEY 仅见 testB 的 1 枚', kloj.count);

  // 计费套餐：超月度解析配额 → 402
  db.db.prepare('UPDATE usage SET parse_count = ? WHERE key = ?').run(5000, NORMAL_KEY);
  let q = await req('POST', '/v1/parse', { Authorization: 'Bearer ' + NORMAL_KEY }, JSON.stringify({ text: '明天8点开会' }));
  assert(q.status === 402, 'free 套餐超出月度配额(5000) → 402 quota_exceeded', q.status);
  db.db.prepare('UPDATE usage SET parse_count = 0 WHERE key = ?').run(NORMAL_KEY); // 复位，避免影响后续

  // 前端单一数据源：index.html 不得再内联 parseAlarm 引擎，必须统一引入 nlu.js（防引擎漂移）
  const idxHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert(!/function parseAlarm\(text, opts\)/.test(idxHtml), '前端单一数据源：index.html 不再内联解析引擎（统一走 nlu.js）', 'found inline engine');
  assert(/<script src="nlu\.js"><\/script>/.test(idxHtml), '前端引入 nlu.js 单文件引擎');

  // ---------- App Key 门控（独立进程：启用 ALARM_APP_KEY） ----------
  console.log('— App Key 门控 —');
  const APPKEY = 'test-app-key-123';
  const APPKEY_DB = path.join(DATA, 'test.appkey.db');
  ['test.appkey.db', 'test.appkey.db-wal', 'test.appkey.db-shm'].forEach(f => { const p = path.join(DATA, f); try { fs.unlinkSync(p); } catch (e) {} });
  const srv2 = spawn(process.execPath, ['server.js'], { env: { ...process.env, PORT: String(PORT + 1), ALARM_DB: APPKEY_DB, ALARM_APP_KEY: APPKEY }, cwd: __dirname });
  srv2.stderr.on('data', d => process.stderr.write('[srv2] ' + d));
  let ready2 = false;
  for (let i = 0; i < 50; i++) { try { const hh = await req2('GET', '/v1/health', {}); if (hh.status === 200) { ready2 = true; break; } } catch (e) {} await new Promise(r => setTimeout(r, 200)); }
  if (!ready2) { console.log('  ✗ srv2(ALARM_APP_KEY) 未就绪，跳过 App Key 测试'); }
  else {
    let ak1 = await req2('POST', '/api/parse', {}, JSON.stringify({ text: '明天8点' }));
    assert(ak1.status === 401, 'App Key 门控：/api/parse 无 key → 401', ak1.status);
    let ak2 = await req2('POST', '/api/parse', { 'x-app-key': APPKEY }, JSON.stringify({ text: '明天8点' }));
    let ak2j = JSON.parse(ak2.body);
    assert(ak2.status === 200 && ak2j.success === true, 'App Key 门控：/api/parse 带 key → 200 解析成功', ak2.status);
    let ak3 = await req2('POST', '/api/parse', { 'x-app-key': 'wrong' }, JSON.stringify({ text: '明天8点' }));
    assert(ak3.status === 401, 'App Key 门控：错误 key → 401', ak3.status);
    let akv = await req2('GET', '/api/vapid', {});
    assert(akv.status === 200 && JSON.parse(akv.body).publicKey, 'App Key 门控：/api/vapid 仍公开 → 200（无需 key）');
    let akidx = await req2('GET', '/', {});
    assert(akidx.status === 200 && akidx.body.includes(APPKEY), 'App Key 注入：首页 meta 携带 app-api-key（同源前端自动附带，防跨域白嫖）', akidx.status);
  }
  try { srv2.kill('SIGKILL'); } catch (e) {}
  await new Promise(r => setTimeout(r, 400));
  ['test.appkey.db', 'test.appkey.db-wal', 'test.appkey.db-shm'].forEach(f => { const p = path.join(DATA, f); try { fs.unlinkSync(p); } catch (e) {} });

  console.log('\n结果： ' + pass + ' 通过 / ' + fail + ' 失败');
  await cleanup();
  process.exit(fail ? 1 : 0);
})();

// 清理：先确保 server 子进程真正退出（SIGKILL + exit 事件），再释放本进程 DB 句柄，最后删除测试库。
// 必须先等子进程退出再 unlink —— 否则 server 仍持有 WAL/SHM 句柄会导致删除失败或文件被重建。
function cleanup() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { receiver.close(); } catch (e) {}
      try { if (db && db.db) db.db.close(); } catch (e) {} // 释放本进程持有的 DB 句柄
      // 仅移除测试专用库（test.alarm.db*），绝不触碰用户 data/alarm.db 与 keys.json
      const errors = [];
      TEST_DB_FILES.forEach(f => {
        const p = path.join(DATA, f);
        for (let attempt = 0; attempt < 5; attempt++) {
          try { if (fs.existsSync(p)) fs.unlinkSync(p); break; }
          catch (e) { if (attempt === 4) errors.push(p.split(/[\\/]/).pop() + ': ' + e.message); }
          if (attempt < 4) { try { fs.rmSync(p, { force: true }); } catch (_) {} }
        }
      });
      if (errors.length) console.log('[cleanup] 警告，未能删除： ' + errors.join(', '));
      else console.log('[cleanup] 已清理测试库 test.alarm.db*');
      resolve();
    };
    try {
      srv.on('exit', finish);
      srv.kill('SIGKILL');
      setTimeout(finish, 1000); // 兜底：若 1s 内未收到 exit 事件也强制清理
    } catch (e) { finish(); }
  });
}
