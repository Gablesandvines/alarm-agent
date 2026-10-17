'use strict';
/*
 * tests/push_api.js — 云端推送 API 集成测试（假阳性 / 无订阅静默跳过缺陷回归）
 * 启动 server.js 子进程（单用户模式：PORT=8095 / 独立库 push.alarm.db），覆盖：
 *   /api/vapid 200 且公钥非空 / /api/register 幂等（同 endpoint 复用、换 endpoint 换 id）/
 *   /api/sub/check 三态（承认/幽灵/缺失）/ 火循环：无订阅告警（不再静默跳过）/
 *   有订阅但 endpoint 无效 → 发送失败日志（且不清订阅）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DATA = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA, 'push.alarm.db');
const DB_FILES = ['push.alarm.db', 'push.alarm.db-wal', 'push.alarm.db-shm'];
// 启动前清掉上一次遗留的测试库，避免脏数据
DB_FILES.forEach(f => { const p = path.join(DATA, f); if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) {} } });

const PORT = 8095;
// 显式构造子进程 env：仅继承必要变量，并确保不含 ALARM_PLATFORM（单用户模式）
const srvEnv = { ...process.env, PORT: String(PORT), ALARM_DB: DB_PATH };
delete srvEnv.ALARM_PLATFORM;
const srv = spawn(process.execPath, ['server.js'], { env: srvEnv, cwd: path.join(__dirname, '..') });
// 捕获 stdout/stderr 到同一缓冲区，供日志断言（console.log→stdout、console.warn→stderr）
const srvLog = [];
srv.stdout.on('data', d => srvLog.push(d.toString()));
srv.stderr.on('data', d => srvLog.push(d.toString()));

function reqOn(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: 'localhost', port, method, path: p, headers: headers || {} }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    // 套接字错误不抛出，避免中断整个测试；以 status:0 表示连接异常
    r.on('error', () => resolve({ status: 0, headers: {}, body: '', error: true }));
    if (body) r.write(body);
    r.end();
  });
}
const req = (method, p, headers, body) => reqOn(PORT, method, p, headers, body);

// 轮询服务端日志缓冲区，直到出现目标子串或超时（仿 test_openapi.js 的 waitFor）
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

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

// 过去 5 秒的 unix 时间戳：触发点刚过、又落在 MISS_GRACE(2min) 内，服务端该轮即触发
const PAST = () => Math.floor(Date.now() / 1000) - 5;

(async () => {
  // 等待服务就绪（单用户模式下 /v1/health 免 Key 200）
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const h = await req('GET', '/v1/health', {}); if (h.status === 200) { ready = true; break; } } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) { console.log('server 未就绪，中止'); await cleanup(); process.exit(1); }

  console.log('— 云端推送 API 集成测试 —');

  // 1. GET /api/vapid → 200 且 publicKey 非空
  const v = await req('GET', '/api/vapid', {});
  const vj = JSON.parse(v.body);
  assert(v.status === 200 && typeof vj.publicKey === 'string' && vj.publicKey.length > 0,
    'GET /api/vapid → 200 且 publicKey 非空', v.status + ' ' + v.body);

  // 2. POST /api/register → clientId 为非空字符串
  const subA = { endpoint: 'https://push.invalid/a', keys: { p256dh: 'x', auth: 'y' } };
  const r2 = await req('POST', '/api/register', {}, JSON.stringify({ subscription: subA }));
  const j2 = JSON.parse(r2.body);
  assert(r2.status === 200 && typeof j2.clientId === 'string' && j2.clientId.length > 0,
    'POST /api/register → clientId 为非空字符串', r2.status + ' ' + r2.body);
  const CID = j2.clientId;

  // 3. 同一订阅重复注册 → 同一 clientId（幂等，不堆订阅行）
  const r3 = await req('POST', '/api/register', {}, JSON.stringify({ subscription: subA }));
  const j3 = JSON.parse(r3.body);
  assert(r3.status === 200 && j3.clientId === CID && j3.reused === true,
    '同一订阅再 POST /api/register → 同一 clientId 且 reused=true（幂等）', r3.status + ' ' + r3.body);

  // 4. 换 endpoint → 不同 clientId
  const r4 = await req('POST', '/api/register', {}, JSON.stringify({ subscription: { endpoint: 'https://push.invalid/b', keys: { p256dh: 'x', auth: 'y' } } }));
  const j4 = JSON.parse(r4.body);
  assert(r4.status === 200 && typeof j4.clientId === 'string' && j4.clientId !== CID,
    '换 endpoint → 不同 clientId', r4.status + ' ' + r4.body);

  // 5. /api/sub/check 三态：承认 → ok:true；幽灵 id → false；不带 clientId → false
  const c1 = await req('GET', '/api/sub/check?clientId=' + encodeURIComponent(CID), {});
  const c2 = await req('GET', '/api/sub/check?clientId=ghost', {});
  const c3 = await req('GET', '/api/sub/check', {});
  assert(c1.status === 200 && JSON.parse(c1.body).ok === true,
    'sub/check 已注册 clientId → ok:true', c1.status + ' ' + c1.body);
  assert(c2.status === 200 && JSON.parse(c2.body).ok === false,
    'sub/check 幽灵 clientId → ok:false', c2.status + ' ' + c2.body);
  assert(c3.status === 200 && JSON.parse(c3.body).ok === false,
    'sub/check 不带 clientId → ok:false', c3.status + ' ' + c3.body);

  // 6. 幽灵 clientId 建闹钟 → ok:true（服务端按 clientId 找不到订阅 → alarm 无 subscription）
  const a1 = await req('POST', '/api/alarm', {}, JSON.stringify({
    clientId: 'ghost', id: 'p1', timestamp: PAST(), time: '00:01', recurrence: 'none', timezone: 'Asia/Shanghai'
  }));
  assert(a1.status === 200 && JSON.parse(a1.body).ok === true,
    'POST /api/alarm（clientId=ghost）→ ok:true', a1.status + ' ' + a1.body);

  // 7. 火循环：无订阅闹钟告警（不再静默跳过）——等日志（≤6s）
  const w1 = await waitForLog('[push] 闹钟 p1 无可用订阅', 6000);
  assert(w1, "火循环无订阅时输出 '[push] 闹钟 p1 无可用订阅' 告警（≤6s，不再静默跳过）");

  // 8. 有效订阅但 endpoint 为 .invalid → 发送失败日志（DNS 快速失败；statusCode 非 404/410 不删订阅）
  const a2 = await req('POST', '/api/alarm', {}, JSON.stringify({
    clientId: CID, id: 'p2', timestamp: PAST(), time: '00:02', recurrence: 'none', timezone: 'Asia/Shanghai'
  }));
  assert(a2.status === 200 && JSON.parse(a2.body).ok === true,
    'POST /api/alarm（有效 clientId）→ ok:true', a2.status + ' ' + a2.body);
  const w2 = await waitForLog('[push] 发送失败 p2', 6000);
  assert(w2, "火循环发送 .invalid endpoint 时输出 '[push] 发送失败 p2'（≤6s）");
  // 附加：发送失败后订阅未被误删（/api/sub/check 仍承认）
  const c4 = await req('GET', '/api/sub/check?clientId=' + encodeURIComponent(CID), {});
  assert(JSON.parse(c4.body).ok === true, '发送失败（非 404/410）后订阅未被误删', c4.body);

  console.log('\n结果： ' + pass + ' 通过 / ' + fail + ' 失败');
  await cleanup();
  process.exit(fail ? 1 : 0);
})();

// 清理：先确保 server 子进程真正退出（SIGKILL + exit 事件），再删除测试库
function cleanup() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      DB_FILES.forEach(f => {
        const p = path.join(DATA, f);
        for (let attempt = 0; attempt < 5; attempt++) {
          try { if (fs.existsSync(p)) fs.unlinkSync(p); break; }
          catch (e) {}
          if (attempt < 4) { try { fs.rmSync(p, { force: true }); } catch (_) {} }
        }
      });
      console.log('[cleanup] 已清理测试库 push.alarm.db*');
      resolve();
    };
    try {
      srv.on('exit', finish);
      srv.kill('SIGKILL');
      setTimeout(finish, 1000); // 兜底：若 1s 内未收到 exit 事件也强制清理
    } catch (e) { finish(); }
  });
}
