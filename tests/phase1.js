'use strict';
/*
 * tests/phase1.js — 第一阶段「先稳」回归（F1 / F2 / E1）
 * 覆盖：
 *   - F1 服务端：/api/alarm 默认 enabled=1、/api/alarm/update 可翻转与缺省 true、未命中 404；
 *               火循环对 enabled=false 的 legacy 行跳过 Web Push。
 *   - F1 前端（源码层面）：toggle→setLegacyEnabled（乐观+同步）、失败回滚、离线队列、且不触碰
 *               推送修复核心（syncedIds / resyncAllToServer / healPushRegistration）。
 *   - E1 PWA：manifest 关键字段合法；sw.js ASSETS 含 ./scheduler.js；index.html 无条件注册 SW。
 *   - F2 双循环：listLegacyAlarms 与 getAllAlarms 双表隔离；同 sig 双触发仅一次投递 + [dedup] 日志。
 *
 * 暴露 run()：启动独立 server 子进程（port 8096 / phase1.alarm.db）做 HTTP/集成断言，返回 {pass,fail}。
 * 不自行 process.exit —— 由 tests/run.js 统一收口退出码。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA, 'phase1.alarm.db');
const DB_FILES = ['phase1.alarm.db', 'phase1.alarm.db-wal', 'phase1.alarm.db-shm'];
DB_FILES.forEach(f => { const p = path.join(DATA, f); try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {} });

const PORT = 8096;
const srvEnv = Object.assign({}, process.env, { PORT: String(PORT), ALARM_DB: DB_PATH });
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

function waitForLog(substr, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (srvLog.join('').indexOf(substr) !== -1) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

// 平衡括号提取某个函数体（从匹配到的起始 { 到配对的 }）
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

function cleanup() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      DB_FILES.forEach(f => {
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
  // 等待服务就绪（单用户模式 /v1/health 免 Key 200）
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const h = await req('GET', '/v1/health', {}); if (h.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.log('phase1: server 未就绪，中止'); await cleanup(); return { pass, fail: fail + 1 }; }

  // 直接打开测试库读取（与 server 子进程共享 WAL）
  const { DatabaseSync } = require('node:sqlite');
  let readDb = null;
  try { readDb = new DatabaseSync(DB_PATH); } catch (e) { console.log('phase1: 无法打开测试库', e.message); }

  console.log('— 第一阶段（F1 / F2 / E1）回归 —');

  // ===================== F1 服务端 =====================
  const PAST = () => Math.floor(Date.now() / 1000) - 5;

  // 1. POST /api/alarm 默认 enabled=1
  const aId = 'f1_' + Date.now();
  const r1 = await req('POST', '/api/alarm', {}, JSON.stringify({ clientId: 'c_f1', id: aId, timestamp: PAST(), time: '07:30', recurrence: 'none', timezone: 'Asia/Shanghai' }));
  assert(r1.status === 200 && JSON.parse(r1.body).ok === true, 'POST /api/alarm → ok:true', r1.status + ' ' + r1.body);
  if (readDb) {
    const row1 = readDb.prepare('SELECT enabled FROM legacy_alarms WHERE id=?').get(aId);
    assert(row1 && row1.enabled === 1, 'POST /api/alarm 后 legacy 行 enabled 默认=1', JSON.stringify(row1));
  }

  // 2. POST /api/alarm/update 翻转 → enabled=0
  const u1 = await req('POST', '/api/alarm/update', {}, JSON.stringify({ clientId: 'c_f1', id: aId, enabled: false }));
  assert(u1.status === 200 && JSON.parse(u1.body).ok === true && JSON.parse(u1.body).enabled === false,
    'POST /api/alarm/update enabled:false → {ok:true,enabled:false}', u1.status + ' ' + u1.body);
  if (readDb) {
    const row2 = readDb.prepare('SELECT enabled FROM legacy_alarms WHERE id=?').get(aId);
    assert(row2 && row2.enabled === 0, 'POST /api/alarm/update 后 legacy 行 enabled=0', JSON.stringify(row2));
  }

  // 3. update 缺省 enabled 视为 true
  const u2 = await req('POST', '/api/alarm/update', {}, JSON.stringify({ clientId: 'c_f1', id: aId }));
  assert(u2.status === 200 && JSON.parse(u2.body).enabled === true, 'POST /api/alarm/update 缺省 enabled → true', u2.status + ' ' + u2.body);

  // 4. update 不存在 → 404 not_found
  const u3 = await req('POST', '/api/alarm/update', {}, JSON.stringify({ clientId: 'c_f1', id: 'no_such', enabled: false }));
  const u3j = JSON.parse(u3.body);
  assert(u3.status === 404 && u3j.error && u3j.error.code === 'not_found', 'POST /api/alarm/update 不存在 → 404 not_found', u3.status + ' ' + u3.body);

  // 5. 火循环跳过 disabled：enabled 行应触发、disabled 行不应触发
  const enId = 'f1_en_' + Date.now(), disId = 'f1_dis_' + Date.now();
  await req('POST', '/api/alarm', {}, JSON.stringify({ clientId: 'c_f1', id: enId, timestamp: PAST(), time: '07:31', recurrence: 'none', timezone: 'Asia/Shanghai' }));
  await req('POST', '/api/alarm', {}, JSON.stringify({ clientId: 'c_f1', id: disId, timestamp: PAST(), time: '07:32', recurrence: 'none', timezone: 'Asia/Shanghai' }));
  await req('POST', '/api/alarm/update', {}, JSON.stringify({ clientId: 'c_f1', id: disId, enabled: false }));
  await sleep(50);
  srvLog.length = 0; // 清空历史日志，只观察本轮
  await sleep(2500);
  const logNow = srvLog.join('');
  assert(logNow.includes('[push] 闹钟 ' + enId + ' 无可用订阅'), '火循环：enabled 行（' + enId + '）正常触发推送', '日志中未见');
  assert(!logNow.includes('[push] 闹钟 ' + disId), '火循环：disabled 行（' + disId + '）被跳过（无推送）', '日志中意外出现');

  // ===================== F2 双表隔离 + 去重 =====================
  if (readDb) {
    const beforeLegacy = readDb.prepare('SELECT count(*) c FROM legacy_alarms').get().c;
    const beforePlat = readDb.prepare('SELECT count(*) c FROM alarms').get().c;
    const isoId = 'iso_' + Date.now();
    await req('POST', '/api/alarm', {}, JSON.stringify({ clientId: 'c_iso', id: isoId, timestamp: PAST(), time: '08:00', recurrence: 'none', timezone: 'Asia/Shanghai' }));
    await sleep(50);
    const afterLegacy = readDb.prepare('SELECT count(*) c FROM legacy_alarms').get().c;
    const afterPlat = readDb.prepare('SELECT count(*) c FROM alarms').get().c;
    assert(afterLegacy === beforeLegacy + 1, 'F2 双表隔离：/api/alarm 仅增加 legacy_alarms（+1）', beforeLegacy + '→' + afterLegacy);
    assert(afterPlat === beforePlat, 'F2 双表隔离：/api/alarm 不写入平台 alarms 表', beforePlat + '→' + afterPlat);

    // 源码层面：两函数各自查不同表
    const dbSrc = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
    assert(/function listLegacyAlarms\(\)[\s\S]*?FROM legacy_alarms/.test(dbSrc), 'F2 双表隔离：listLegacyAlarms 查 legacy_alarms 表');
    assert(/function getAllAlarms\(\)[\s\S]*?FROM alarms/.test(dbSrc), 'F2 双表隔离：getAllAlarms 查 alarms 表');
  }

  // dedup：同 sig 双 legacy 闹钟，仅一次投递 + [dedup] 日志
  const d1 = 'dedup_1_' + Date.now(), d2 = 'dedup_2_' + Date.now();
  const dupBody = (id) => JSON.stringify({ clientId: 'c_dup', id, timestamp: PAST(), time: '09:00', recurrence: 'none', label: 'duplicate_sig', timezone: 'Asia/Shanghai' });
  await req('POST', '/api/alarm', {}, dupBody(d1));
  await req('POST', '/api/alarm', {}, dupBody(d2));
  await sleep(50);
  srvLog.length = 0;
  await sleep(2500);
  const logDup = srvLog.join('');
  // 仅统计本对（dedup_1_/dedup_2_）的投递；同窗口内其它 legacy 闹钟（iso_/f1_en_）的推送不应计入
  const pushDedupPair = (logDup.match(/\[push\] 闹钟 dedup_[12]_/g) || []).length;
  assert(logDup.includes('[dedup]'), 'F2 dedup：同 sig 双触发打印 [dedup] 日志', '日志中未见 [dedup]');
  assert(pushDedupPair === 1, 'F2 dedup：同 sig 双触发仅一次投递（dedup_1/2 仅一个 [push]）', '实际 ' + pushDedupPair + ' 次');

  // ===================== F1 前端（源码层面） =====================
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const toggleFn = extractFn(html, /function toggle\(id\)\{/);
  assert(toggleFn.includes('setLegacyEnabled(a)'), 'F1 前端：toggle 调用 setLegacyEnabled(a)（乐观更新后同步）');
  ['syncedIds', 'resyncAllToServer', 'healPushRegistration'].forEach(idn => {
    assert(!toggleFn.includes(idn), 'F1 前端：toggle 未引用 ' + idn + '（绝对约束）');
  });
  assert(html.includes('async function setLegacyEnabled'), 'F1 前端：setLegacyEnabled 已定义');
  const setFn = extractFn(html, /async function setLegacyEnabled\(a\)\{/);
  assert(setFn.includes("fetch('/api/alarm/update'"), 'F1 前端：setLegacyEnabled 调 /api/alarm/update');
  assert(setFn.includes('!res.ok'), 'F1 前端：setLegacyEnabled 检测非 2xx（!res.ok）避免静默吞掉');
  assert(setFn.includes("toast('同步失败，已回滚')"), 'F1 前端：setLegacyEnabled 失败回滚 toast');
  ['syncedIds', 'resyncAllToServer', 'healPushRegistration'].forEach(idn => {
    assert(!setFn.includes(idn), 'F1 前端：setLegacyEnabled 未引用 ' + idn + '（绝对约束）');
  });
  assert(html.includes('function queueEnabled') && html.includes('function flushEnabledQueue'), 'F1 前端：离线队列 queueEnabled/flushEnabledQueue 已定义');
  assert(html.includes("window.addEventListener('online', flushEnabledQueue)"), 'F1 前端：注册 online 事件冲刷离线队列');
  ['syncedIds', 'resyncAllToServer', 'healPushRegistration'].forEach(idn => {
    assert(html.includes(idn), 'F1 前端：' + idn + ' 仍存在（推送修复核心未被删）');
  });

  // ===================== E1 PWA =====================
  let manifestOk = true;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
    assert(typeof manifest.name === 'string' && manifest.name.length > 0, 'E1 manifest：name 存在');
    assert(typeof manifest.short_name === 'string' && manifest.short_name.length > 0, 'E1 manifest：short_name 存在');
    assert(manifest.start_url && manifest.display === 'standalone', 'E1 manifest：start_url 与 display=standalone');
    assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'E1 manifest：icons 非空（SVG，无新增 PNG）');
  } catch (e) { manifestOk = false; assert(false, 'E1 manifest：合法 JSON', e.message); }

  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const assetsMatch = sw.match(/const ASSETS=\[([\s\S]*?)\]/);
  assert(assetsMatch && assetsMatch[1].includes("'./scheduler.js'"), 'E1 sw.js：ASSETS 含 ./scheduler.js（离线缺口补齐）');

  assert(html.includes('function initSW('), 'E1 index.html：initSW 已定义');
  const initSwFn = extractFn(html, /async function initSW\(\)\{/);
  assert(initSwFn.includes("navigator.serviceWorker.register('sw.js')"), 'E1 index.html：initSW 无条件 register(sw.js)');
  assert(!initSwFn.includes("'PushManager'"), 'E1 index.html：initSW 不受 PushManager 门控（真正无条件）');
  assert(html.includes('await initSW()') || html.includes('initSW();'), 'E1 index.html：initSW 在 load 流程被调用');
  assert(html.includes('if(!swReg) swReg=await navigator.serviceWorker.register'), 'E1 index.html：initPush 内 register 改为幂等（if(!swReg)）');

  console.log('\n[phase1] 结果： ' + pass + ' 通过 / ' + fail + ' 失败');
  await cleanup();
  return { pass, fail };
}

module.exports = { run };
