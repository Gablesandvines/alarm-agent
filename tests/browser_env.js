'use strict';
/* ============================================================
 * tests/browser_env.js — 浏览器环境回归（<script> 方式、无 module/require）
 * 背景：P3 曾因 scheduler.js 的 module.exports 未做守卫，在浏览器抛
 *   "module is not defined"，导致 window.Scheduler 未挂载 →
 *   nlu.js sched().tzDateParts is not a function（Node 测试全绿但浏览器红）。
 * 用 vm 模拟浏览器全局（有 window、无 module/require）加载两文件，锁定该回归。
 * ============================================================ */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

// 模拟浏览器全局：window 存在、Intl/Date 可用，但无 module / require / exports
const sandbox = {
  window: {}, Intl, Date, console, Math, JSON, Object, Array, String, Number,
  RegExp, Error, parseInt, parseFloat, isNaN
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

console.log('— 浏览器环境回归（scheduler.js / nlu.js 以 <script> 方式、无 module）—');
for (const f of ['scheduler.js', 'nlu.js']) {
  try {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
    assert(true, f + ' 在无 module 环境加载不抛错');
  } catch (e) { assert(false, f + ' 加载不抛错', e.message); }
}

assert(sandbox.window.Scheduler && typeof sandbox.window.Scheduler.tzDateParts === 'function',
  'window.Scheduler 已挂载且含 tzDateParts（浏览器可用）');
assert(typeof sandbox.window.parseAlarm === 'function', 'window.parseAlarm 已挂载');

try {
  const r = sandbox.window.parseAlarm('明天早上8点叫我起床', { tz: 'America/New_York' });
  assert(r && r.success && r.alarm.timezone === 'America/New_York' && /-0[45]:00$/.test(r.alarm.datetime),
    '浏览器端按时区解析（NY，DST 偏移 -04:00/-05:00）', r && r.alarm ? r.alarm.datetime : String(r));
} catch (e) { assert(false, '浏览器端 parseAlarm(带 tz) 调用不抛错', e.message); }

try {
  const r2 = sandbox.window.parseAlarm('明天8点');
  assert(r2 && r2.success && r2.alarm.timezone === 'Asia/Shanghai',
    '浏览器端默认时区=上海（向后兼容）', r2 && r2.alarm ? r2.alarm.timezone : String(r2));
} catch (e) { assert(false, '默认时区解析不抛错', e.message); }

console.log('\n结果： ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
