'use strict';
/*
 * tests/phase2.js — 第二阶段第一批（F3 / F6 / I3）回归
 * 覆盖：
 *   - F3 贪睡服务端化（服务端）：POST /api/alarm kind=snooze → 200 且 fire_log 1 行 snooze(alarm_id=原)；
 *        再 POST 同 snz id → legacy_alarms 仍 1 行（覆盖不堆积）；原闹钟 timestamp/recurrence 未变；
 *        snz 到期触发 → fire_log 出现 ring 且 alarm_id LIKE snz_%。
 *   - F3 前端（源码）：ringSnooze 块含 'snz_' / ringingId / kind:'snooze'，且不把原闹钟 a.recurrence='none' 写回。
 *   - F6 后端：/api/firelog 缺 clientId→400、正常→升序、[from,to) 半开边界；listFireLog 升序；
 *        pruneFireLog 删旧留新；fire_log 9 列；计数口径 snoozeCount=1 / snoozeRing=1 / ringCount=0。
 *   - F6 前端（源码）：renderToday 存在、含 snz_ 前缀「贪睡响铃」徽标、含离线只读提示。
 *   - I3（源码）：sampleOccurrences/detectConflicts/checkConflict 存在；typeof Scheduler==='undefined' 守卫、
 *        60000 / 60 / 90 / try；saveAlarm/commitEdit/modify 调用 checkConflict；冲突分支无 return（非阻塞）。
 *   - 不变量：syncedIds/resyncAllToServer/healPushRegistration 仍在；toggle/setLegacyEnabled 未引用它们。
 *
 * 暴露 run()：启动独立 server 子进程（port 8097 / phase2.alarm.db）做 HTTP/集成断言；
 * 另以隔离单元库 phase2.unit.db 直接测 db.js 的 logFire/listFireLog/pruneFireLog 纯函数（避免锁竞争）。
 * 不自行 process.exit —— 由 tests/run.js 统一收口退出码。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SRV_DB = path.join(DATA, 'phase2.alarm.db');
const UNIT_DB = path.join(DATA, 'phase2.unit.db');
const CLEAN = [
  'phase2.alarm.db', 'phase2.alarm.db-wal', 'phase2.alarm.db-shm',
  'phase2.unit.db', 'phase2.unit.db-wal', 'phase2.unit.db-shm'
];
CLEAN.forEach(f => { const p = path.join(DATA, f); try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} });

// 隔离单元库：直接测 db.js 纯函数（logFire/listFireLog/pruneFireLog），与 server 库分离避免锁竞争
process.env.ALARM_DB = UNIT_DB;
const dbm = require('../db.js');

const PORT = 8097;
const srvEnv = Object.assign({}, process.env, { PORT: String(PORT), ALARM_DB: SRV_DB });
delete srvEnv.ALARM_PLATFORM;
const srv = spawn(process.execPath, ['server.js'], { env: srvEnv, cwd: ROOT });
const srvLog = [];
srv.stdout.on('data', d => srvLog.push(d.toString()));
srv.stderr.on('data', d => srvLog.push(d.toString()));

function reqOn(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: 'localhost', port, method, path: p, headers: headers || {} }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    r.on('error', () => resolve({ status: 0, headers: {}, body: '', error: true }));
    if (body) r.write(body);
    r.end();
  });
}
const req = (method, p, headers, body) => reqOn(PORT, method, p, headers, body);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function waitFor(cond, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => { if (cond()) return resolve(true); if (Date.now() - t0 > timeoutMs) return resolve(false); setTimeout(tick, 150); };
    tick();
  });
}
// 平衡括号提取函数体（与 phase1 同范式）
function extractFn(src, startRe) {
  const m = src.match(startRe);
  if (!m) return '';
  let depth = 0, i = m.index;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

function cleanup() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      try { if (dbm && dbm.db) dbm.db.close(); } catch (e) {}
      CLEAN.forEach(f => {
        const p = path.join(DATA, f);
        for (let attempt = 0; attempt < 5; attempt++) {
          try { if (fs.existsSync(p)) fs.unlinkSync(p); break; } catch (e) {}
          if (attempt < 4) { try { fs.rmSync(p, { force: true }); } catch (_) {} }
        }
      });
      resolve();
    };
    try { srv.on('exit', finish); srv.kill('SIGKILL'); setTimeout(finish, 1000); }
    catch (e) { finish(); }
  });
}

async function run() {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const h = await req('GET', '/v1/health', {}); if (h.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.log('phase2: server 未就绪，中止'); await cleanup(); return { pass, fail: fail + 1 }; }

  // 与服务端库共享读取（WAL：只读 SELECT 与 server 写入并发安全）
  const { DatabaseSync } = require('node:sqlite');
  let readDb = null;
  try { readDb = new DatabaseSync(SRV_DB); } catch (e) { console.log('phase2: 无法打开测试库', e.message); }

  console.log('— 第二阶段（F3 / F6 / I3）回归 —');

  // ===================== F3 服务端：贪睡落库不堆积 + 原闹钟不变 =====================
  const cidF3 = 'c_f3';
  const origId = 'orig_' + Date.now();
  const futTs = Math.floor(Date.now() / 1000) + 3600;             // 未来 → 不会在测试期内响
  await req('POST', '/api/alarm', {}, JSON.stringify({ clientId: cidF3, id: origId, timestamp: futTs, time: '23:00', recurrence: 'daily', label: 'orig', timezone: 'Asia/Shanghai' }));
  if (readDb) {
    const before = readDb.prepare('SELECT timestamp, recurrence FROM legacy_alarms WHERE id=?').get(origId);
    const snzId = 'snz_' + origId;
    const pastTs = Math.floor(Date.now() / 1000) - 5;
    const snzBody = JSON.stringify({ clientId: cidF3, id: snzId, parentId: origId, kind: 'snooze', timestamp: pastTs, time: '07:09', recurrence: 'none', label: 'orig', timezone: 'Asia/Shanghai' });
    const rS = await req('POST', '/api/alarm', {}, snzBody);
    assert(rS.status === 200 && JSON.parse(rS.body).ok === true, 'F3 POST /api/alarm kind=snooze → 200 ok', rS.status + ' ' + rS.body);

    const snzLogged = await waitFor(() => readDb.prepare("SELECT count(*) c FROM fire_log WHERE client_id=? AND kind='snooze' AND alarm_id=?").get(cidF3, origId).c >= 1, 3000);
    assert(snzLogged, 'F3 kind=snooze → fire_log 有 1 行 snooze(alarm_id=原闹钟)', 'not found');

    // 再 POST 同 snz id → legacy_alarms snz 行仍为 1（覆盖不堆积）
    await req('POST', '/api/alarm', {}, snzBody);
    const snzRows = readDb.prepare('SELECT count(*) c FROM legacy_alarms WHERE id=?').get(snzId).c;
    assert(snzRows === 1, 'F3 再 POST 同 snz id → legacy_alarms 仍 1 行（覆盖不堆积）', 'count=' + snzRows);

    // 原闹钟 timestamp/recurrence 未变
    const after = readDb.prepare('SELECT timestamp, recurrence FROM legacy_alarms WHERE id=?').get(origId);
    assert(before && after && before.timestamp === after.timestamp && before.recurrence === after.recurrence,
      'F3 贪睡不改原闹钟 timestamp/recurrence', JSON.stringify({ before, after }));
  }

  // ===================== F6 + F3：snooze 行 + snz ring 行并存 + 计数口径 =====================
  const cidCnt = 'c_cnt';
  const origCnt = 'cnt_' + Date.now();
  const snzCnt = 'snz_' + origCnt;
  const fut2 = Math.floor(Date.now() / 1000) + 3600;
  const past2 = Math.floor(Date.now() / 1000) - 5;
  await req('POST', '/api/alarm', {}, JSON.stringify({ clientId: cidCnt, id: origCnt, timestamp: fut2, time: '22:00', recurrence: 'none', label: 'cnt-orig', timezone: 'Asia/Shanghai' }));
  await req('POST', '/api/alarm', {}, JSON.stringify({ clientId: cidCnt, id: snzCnt, parentId: origCnt, kind: 'snooze', timestamp: past2, time: '07:19', recurrence: 'none', label: 'cnt-orig', timezone: 'Asia/Shanghai' }));
  const snzRang = await waitFor(() => {
    if (!readDb) return true;
    return readDb.prepare("SELECT count(*) c FROM fire_log WHERE client_id=? AND kind='ring' AND alarm_id=?").get(cidCnt, snzCnt).c >= 1;
  }, 4000);
  assert(snzRang, 'F3 snz 到期触发 → fire_log 出现 ring 且 alarm_id 形如 snz_原', 'ring not found');

  // GET /api/firelog：缺 clientId → 400；正常 → 升序；计数口径
  const flBad = await req('GET', '/api/firelog', {}, null);
  assert(flBad.status === 400 && JSON.parse(flBad.body).error && JSON.parse(flBad.body).error.code === 'bad_request', 'F6 GET /api/firelog 缺 clientId → 400 bad_request', flBad.status + ' ' + flBad.body);

  const fl = await req('GET', '/api/firelog?clientId=' + cidCnt, {}, null);
  const flj = JSON.parse(fl.body);
  assert(fl.status === 200 && Array.isArray(flj.logs), 'F6 GET /api/firelog?clientId → 200 列表', fl.status);
  const ascending = flj.logs.every((x, i, a) => i === 0 || a[i - 1].fired_at <= x.fired_at);
  assert(ascending, 'F6 /api/firelog 返回按 fired_at 升序', JSON.stringify(flj.logs.map(x => x.fired_at)));
  // 计数口径（§2.6）：snoozeCount=1、snoozeRing=1、ringCount=0（原闹钟未来未响）
  let snoozeCount = 0, ringCount = 0, snoozeRing = 0;
  flj.logs.forEach(l => {
    if (l.kind === 'snooze') snoozeCount++;
    else if (l.kind === 'ring') { if ((l.alarm_id || '').indexOf('snz_') === 0) snoozeRing++; else ringCount++; }
  });
  assert(snoozeCount === 1, 'F6 计数口径：snoozeCount=1（每次贪睡计 1）', 'snoozeCount=' + snoozeCount);
  assert(snoozeRing === 1, 'F6 计数口径：snoozeRing=1（snz_ ring 单列）', 'snoozeRing=' + snoozeRing);
  assert(ringCount === 0, 'F6 计数口径：ringCount=0（原闹钟未来未响，不与贪睡响铃重复计）', 'ringCount=' + ringCount);

  // ===================== F6 db.js 纯函数：9 列 / 半开边界 / 升序 / prune（隔离单元库） =====================
  const cols = dbm.db.prepare('PRAGMA table_info(fire_log)').all().map(c => c.name);
  assert(cols.length === 9, 'F6 fire_log 表含 9 列', 'cols=' + cols.length + ':' + cols.join(','));
  const t0 = Date.now();
  dbm.logFire({ client_id: 'u1', kind: 'ring', fired_at: t0 + 100 });
  dbm.logFire({ client_id: 'u1', kind: 'ring', fired_at: t0 + 50 });
  const within = dbm.listFireLog({ clientId: 'u1', from: t0 + 1, to: t0 + 100 }); // 半开：t0+100 排除
  assert(within.length === 1 && within[0].fired_at === t0 + 50, 'F6 listFireLog 半开区间 [from,to) 排除 fired_at==to', 'len=' + within.length);
  const allU1 = dbm.listFireLog({ clientId: 'u1' });
  assert(allU1.length === 2 && allU1[0].fired_at <= allU1[1].fired_at, 'F6 listFireLog 按 fired_at 升序', JSON.stringify(allU1.map(x => x.fired_at)));
  const pruned = dbm.pruneFireLog(t0 + 55);
  const remain = dbm.listFireLog({ clientId: 'u1' });
  assert(pruned === 1 && remain.length === 1 && remain[0].fired_at === t0 + 100, 'F6 pruneFireLog 删旧（<before）留新', 'pruned=' + pruned + ' remain=' + remain.length);

  // ===================== F3 / F6 / I3 源码断言 =====================
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  // F3：ringSnooze 块含 snz_/ringingId/kind:'snooze'，且不把原闹钟 a.recurrence='none' 写回
  const snoozeBlock = extractFn(html, /\$\('ringSnooze'\)\.onclick=\(\)=>\{/);
  assert(snoozeBlock.includes("'snz_'") || snoozeBlock.includes('"snz_"'), 'F3 ringSnooze 块含 snz_ 前缀（复用同 id 不堆积）');
  assert(snoozeBlock.includes('ringingId'), 'F3 ringSnooze 块用 ringingId 定位（替代按 time 文本匹配）');
  assert(snoozeBlock.includes("kind:'snooze'"), 'F3 ringSnooze 块写入 kind:snooze');
  assert(!snoozeBlock.includes("a.recurrence='none'"), 'F3 ringSnooze 块不再把原闹钟 a.recurrence=none 写回（修 bug）');

  // F6 前端：renderToday + 贪睡响铃徽标 + 离线只读
  assert(html.includes('async function renderToday'), 'F6b index.html 定义 renderToday');
  assert(html.includes('贪睡响铃'), 'F6b 时间线含「贪睡响铃」徽标（snz_ 前缀 ring）');
  assert(html.includes('离线：历史记录需联网查看'), 'F6b 含离线只读提示');
  assert(html.includes('id="todayList"') && html.includes('id="nextAgg"'), 'F6b 今日视图与下次触发聚合卡片存在');

  // I3 源码：函数 + 守卫 + 阈值 + try + 调用点 + 无 return（非阻塞）
  assert(html.includes('function sampleOccurrences') && html.includes('function detectConflicts') && html.includes('function checkConflict'), 'I3 定义 sampleOccurrences/detectConflicts/checkConflict');
  assert(html.includes("typeof Scheduler==='undefined'"), 'I3 含 typeof Scheduler===\'undefined\' 降级守卫');
  assert(html.includes('60000'), 'I3 冲突阈值 60000ms（|t1-t2|<=60s）');
  assert(html.includes('CONF_MAX_N=60') && html.includes('90*86400000') && html.includes('CONF_MAX_ALARMS=200'), 'I3 采样上限 60 次/90 天/扫表 200');
  const detectFn = extractFn(html, /function detectConflicts\(candidate, excludeId\)\{/);
  assert(detectFn.includes('try') && detectFn.includes('catch'), 'I3 detectConflicts 含 try-catch 静默降级');
  const checkFn = extractFn(html, /function checkConflict\(candidate, excludeId\)\{/);
  assert(!/\breturn\b/.test(checkFn), 'I3 checkConflict 冲突分支无 return（非阻塞，不拦截保存）');
  const saveFn = extractFn(html, /function saveAlarm\(\)\{/);
  const commitFn = extractFn(html, /function commitEdit\(id\)\{/);
  const modifyFn = extractFn(html, /function applyIntentMatch\(match, action, update\)\{/);
  assert(saveFn.includes('checkConflict'), 'I3 saveAlarm 调用 checkConflict');
  assert(commitFn.includes('checkConflict'), 'I3 commitEdit 调用 checkConflict');
  assert(modifyFn.includes('checkConflict'), 'I3 applyIntentMatch(modify) 调用 checkConflict');

  // 不变量：三核心仍在；toggle/setLegacyEnabled 未引用它们
  ['syncedIds', 'resyncAllToServer', 'healPushRegistration'].forEach(idn => {
    assert(html.includes(idn), '不变量：' + idn + ' 仍存在（phase1 推送修复核心未删）');
  });
  const toggleFn = extractFn(html, /function toggle\(id\)\{/);
  const setEnFn = extractFn(html, /async function setLegacyEnabled\(a\)\{/);
  ['syncedIds', 'resyncAllToServer', 'healPushRegistration'].forEach(idn => {
    assert(!toggleFn.includes(idn), '不变量：toggle 未引用 ' + idn);
    assert(!setEnFn.includes(idn), '不变量：setLegacyEnabled 未引用 ' + idn);
  });

  try { if (readDb) readDb.close(); } catch (e) {}
  console.log('\n[phase2] 结果： ' + pass + ' 通过 / ' + fail + ' 失败');
  await cleanup();
  return { pass, fail };
}

module.exports = { run };
