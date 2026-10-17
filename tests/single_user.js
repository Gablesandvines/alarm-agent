'use strict';
/*
 * tests/single_user.js — 单用户模式集成测试（能力冻结 方案 A：休眠 + 单用户默认）
 * 不设置 ALARM_PLATFORM（默认单用户模式）启动 server.js 子进程（独立端口 8098 / 独立库
 * single.alarm.db），覆盖：
 *   health 免 Key 200 / parse 免 Key 成功 / 非法时区 400 / 携带错误 key 401 /
 *   /v1/keys 冻结 404（GET/POST）/ 免 Key 创建托管闹钟 201 /
 *   usage 免 Key 200 且 quota=null（软计费冻结）/ 内置单用户密钥行字段校验
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DATA = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA, 'single.alarm.db');
const DB_FILES = ['single.alarm.db', 'single.alarm.db-wal', 'single.alarm.db-shm'];
// 启动前清掉上一次遗留的测试库，避免脏数据
DB_FILES.forEach(f => { const p = path.join(DATA, f); if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e) {} } });
process.env.ALARM_DB = DB_PATH;

// 进程内 db.js 指向 single.alarm.db，供结束后校验内置单用户密钥行
const db = require('../db.js');

const PORT = 8098;
// 显式构造子进程 env：仅继承必要变量，并确保不含 ALARM_PLATFORM（单用户模式）
const srvEnv = { ...process.env, PORT: String(PORT), ALARM_DB: DB_PATH };
delete srvEnv.ALARM_PLATFORM;
const srv = spawn(process.execPath, ['server.js'], { env: srvEnv, cwd: path.join(__dirname, '..') });
srv.stderr.on('data', d => process.stderr.write('[server] ' + d));

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

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

(async () => {
  // 等待 /v1/health 200 就绪
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const h = await req('GET', '/v1/health', {}); if (h.status === 200) { ready = true; break; } } catch (e) {}
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) { console.log('server 未就绪，中止'); await cleanup(); process.exit(1); }

  console.log('— 单用户模式集成测试 —');

  // 1. health 免 Key
  let h = await req('GET', '/v1/health', {});
  let hj = JSON.parse(h.body);
  assert(h.status === 200 && hj.status === 'ok', 'GET /v1/health → 200 且 status=ok（免 Key）', h.status);

  // 2. parse 免 Key 可用
  let p = await req('POST', '/v1/parse', {}, JSON.stringify({ text: '明天早上8点提醒我' }));
  let pj = JSON.parse(p.body);
  assert(p.status === 200 && pj.success === true, 'POST /v1/parse 免 Key → 200 success', p.status);

  // 3. 非法时区 → 400 invalid_timezone
  p = await req('POST', '/v1/parse', {}, JSON.stringify({ text: '明天早上8点提醒我', timezone: 'Not/AZone' }));
  pj = JSON.parse(p.body);
  assert(p.status === 400 && pj.error && pj.error.code === 'invalid_timezone', 'POST /v1/parse 非法 timezone=Not/AZone → 400 invalid_timezone', p.status + ' ' + p.body);

  // 4. 携带错误 key → 401 invalid_api_key（携带 key 时仍严格校验）
  p = await req('POST', '/v1/parse', { Authorization: 'Bearer sk_wrong_key' }, JSON.stringify({ text: '明天早上8点提醒我' }));
  pj = JSON.parse(p.body);
  assert(p.status === 401 && pj.error && pj.error.code === 'invalid_api_key', 'POST /v1/parse 带错误 Key → 401 invalid_api_key', p.status + ' ' + p.body);

  // 5. /v1/keys 平台能力冻结 → 404（GET/POST 均 404，不泄露内置密钥）
  let kg = await req('GET', '/v1/keys', {});
  let kgj = JSON.parse(kg.body);
  assert(kg.status === 404 && kgj.error && kgj.error.code === 'not_found', 'GET /v1/keys 单用户模式冻结 → 404 not_found', kg.status);
  let kp = await req('POST', '/v1/keys', {}, JSON.stringify({ label: 'x' }));
  assert(kp.status === 404, 'POST /v1/keys 单用户模式冻结 → 404', kp.status);

  // 6. 免 Key 创建托管闹钟 → 201（tenant=default）
  let c = await req('POST', '/v1/alarms', {}, JSON.stringify({ text: '明天晚上9点睡觉' }));
  let cj = JSON.parse(c.body);
  assert(c.status === 201 && cj.id && cj.tenant === 'default', 'POST /v1/alarms 免 Key 创建 → 201（tenant=default）', c.status);

  // 7. usage 免 Key → 200 且 quota=null（软计费冻结）
  let u = await req('GET', '/v1/usage', {});
  let uj = JSON.parse(u.body);
  assert(u.status === 200 && uj.usage && uj.usage.quota === null, 'GET /v1/usage 免 Key → 200 且 quota=null（无配额限制）', u.status + ' ' + u.body);

  // 8. 内置单用户密钥行校验（进程内直查同库）
  const k = db.getKey(db.SINGLE_USER_KEY);
  assert(!!k && k.enabled === true && k.plan === 'single' && k.tenant === 'default' && k.rate_limit === 1000000,
    '内置单用户密钥行：enabled=true, plan=single, tenant=default, rate_limit=1000000',
    JSON.stringify(k));

  console.log('\n结果： ' + pass + ' 通过 / ' + fail + ' 失败');
  await cleanup();
  process.exit(fail ? 1 : 0);
})();

// 清理：先确保 server 子进程真正退出（SIGKILL + exit 事件），再释放本进程 DB 句柄，最后删除测试库。
function cleanup() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { if (db && db.db) db.db.close(); } catch (e) {} // 释放本进程持有的 DB 句柄
      DB_FILES.forEach(f => {
        const p = path.join(DATA, f);
        for (let attempt = 0; attempt < 5; attempt++) {
          try { if (fs.existsSync(p)) fs.unlinkSync(p); break; }
          catch (e) {}
          if (attempt < 4) { try { fs.rmSync(p, { force: true }); } catch (_) {} }
        }
      });
      console.log('[cleanup] 已清理测试库 single.alarm.db*');
      resolve();
    };
    try {
      srv.on('exit', finish);
      srv.kill('SIGKILL');
      setTimeout(finish, 1000); // 兜底：若 1s 内未收到 exit 事件也强制清理
    } catch (e) { finish(); }
  });
}
