'use strict';
/*
 * tests/push_client.js — 云端推送前端自愈 vm 回归（假阳性 + 双通道全断缺陷）
 * 仿 tests/browser_env.js 的 vm 模式，但加载 index.html 内联脚本，覆盖：
 *   a. subKeyMatches：VAPID 公钥逐字节比对（相同→true / 差一字节→false / 无 options→false / 无 key→false）
 *   b. healPushRegistration（密钥匹配）：不 unsubscribe/subscribe，直接 fetch /api/register，状态=已开启
 *   c. healPushRegistration（密钥不匹配）：先 unsubscribe 再 subscribe，新订阅绑定的公钥与当前 vapid 逐字节一致
 *   d. initPush 全流程：serverOk=false+keyOk=false → 自动自愈（发生 register）且状态=已开启；
 *      serverOk=true+keyOk=true → 不发生 unsubscribe/subscribe/register，状态=已开启
 *   e. notify 让位条件：仅已确认同步到服务端的闹钟让位给 Service Worker；未同步（服务端无订阅）本地兜底通知
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

// ---- 测试样本：VAPID 公钥 base64url（仅作字节比对，无需真实 EC 点）----
const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const B64 = keyBytes.toString('base64url');

// ---- 浏览器全局桩 ----
const elements = new Map();
function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {},
    classList: { add() {}, remove() {} },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    appendChild() {}, setAttribute() {}, focus() {}
  };
}
const documentStub = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
  createElement(tag) { return makeEl('<' + tag + '>'); },
  querySelector() { return null; },          // meta[name=app-api-key] 读不到 → App Key 为空
  querySelectorAll() { return []; },
  addEventListener() {}
};
const localStorageStub = (() => {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); }
  };
})();

// 调用记录（跨场景重置）
const calls = { unsubscribe: 0, subscribe: 0, fetchUrls: [] };
const notifCalls = [];
// Notification spy：可被 new，记录构造次数与参数；权限恒 granted
function NotificationSpy(title, opts) { notifCalls.push({ title: title, opts: opts }); }
NotificationSpy.permission = 'granted';
NotificationSpy.requestPermission = async () => 'granted';

// Service Worker 桩：register 返回同一 swStub；pushManager 订阅可随场景替换
let currentFakeSub = null;
function makeFakeSub(keyArr, ep) {
  return {
    endpoint: ep || 'https://push.example/fake',
    options: { applicationServerKey: keyArr },
    toJSON() { return { endpoint: this.endpoint, options: { applicationServerKey: this.options.applicationServerKey }, keys: { p256dh: 'p', auth: 'a' } }; },
    unsubscribe: async () => { calls.unsubscribe++; currentFakeSub = null; return true; }
  };
}
const swStub = {
  ready: Promise.resolve(),
  pushManager: {
    getSubscription: async () => currentFakeSub,
    subscribe: async (opts) => {
      calls.subscribe++;
      // 按传入的 applicationServerKey 造新假订阅（浏览器真实行为：订阅绑定该公钥）
      currentFakeSub = makeFakeSub(opts && opts.applicationServerKey, 'https://push.example/new-' + calls.subscribe);
      return currentFakeSub;
    }
  }
};

// 服务端返回的可变开关（initPush 场景间翻转）
const server = { ok: false };
const fetchStub = async (url) => {
  const u = String(url);
  calls.fetchUrls.push(u);
  if (u.indexOf('/api/vapid') !== -1) return { ok: true, json: async () => ({ publicKey: B64 }) };
  if (u.indexOf('/api/register') !== -1) return { ok: true, json: async () => ({ clientId: 'c_test', reused: false }) };
  if (u.indexOf('/api/sub/check') !== -1) return { ok: true, json: async () => ({ ok: server.ok }) };
  return { ok: true, json: async () => ({ ok: true }) }; // /api/alarm 等一律放行
};

const sandbox = {
  console, Intl, URL, atob, Date, Math, JSON, Object, Array, String, Number,
  navigator: { serviceWorker: { register: async () => swStub, ready: swStub.ready } },
  document: documentStub,
  localStorage: localStorageStub,
  Notification: NotificationSpy,
  fetch: fetchStub,
  PushManager: function PushManager() {},
  setTimeout: () => 0, clearTimeout: () => {},   // no-op：toast 的延时收起不挂起测试
  setInterval: () => 0, clearInterval: () => {} // no-op：tick/setInterval 不真正起轮询
};
sandbox.window = sandbox;      // window 即 context 本身
sandbox.globalThis = sandbox;
sandbox.addEventListener = (type, cb) => { if (type === 'load') sandbox.loadCallback = cb; }; // 捕获 load 回调，不触发
vm.createContext(sandbox);

console.log('— 云端推送前端自愈 vm 回归 —');

// ---- 0. 前置：index.html 有且仅有一个内联 <script>；先跑 scheduler.js 提供 window.Scheduler ----
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const scripts = []; let mm;
while ((mm = re.exec(html)) !== null) scripts.push(mm[1]);
assert(scripts.length === 1, 'index.html 有且仅有一个内联 <script> 块', '实际 ' + scripts.length + ' 个');

try {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'scheduler.js'), 'utf8'), sandbox, { filename: 'scheduler.js' });
  assert(true, 'scheduler.js 在 vm（无 module）加载不抛错');
} catch (e) { assert(false, 'scheduler.js 在 vm 加载不抛错', e.message); }
assert(sandbox.window.Scheduler && typeof sandbox.window.Scheduler.tzDateParts === 'function',
  'window.Scheduler 已挂载且含 tzDateParts');

try {
  vm.runInContext(scripts[0], sandbox, { filename: 'index.html<script>' });
  assert(true, 'index.html 内联脚本在 vm 加载不抛错（load 回调已捕获未触发）');
} catch (e) { assert(false, 'index.html 内联脚本在 vm 加载不抛错', e.message + '\n' + (e.stack || '')); }
assert(typeof sandbox.loadCallback === 'function' && sandbox.loadCallback.name === 'initPush',
  "window load 回调=initPush（已捕获）", typeof sandbox.loadCallback);
if (fail) { console.log('\n结果： ' + pass + ' 通过 / ' + fail + ' 失败（加载失败，提前终止）'); process.exit(1); }

(async () => {
// vm 内解码当前公钥（与脚本内部 urlBase64ToUint8 同一实现，保证字节级一致）
const k = sandbox.urlBase64ToUint8(B64);

// ---- a. subKeyMatches ----
assert(sandbox.subKeyMatches(makeFakeSub(k), B64) === true, 'subKeyMatches: 公钥逐字节相同 → true');
const diff = Uint8Array.from(k); diff[0] = diff[0] ^ 0xff;
assert(sandbox.subKeyMatches(makeFakeSub(diff), B64) === false, 'subKeyMatches: 差一个字节 → false');
assert(sandbox.subKeyMatches({ endpoint: 'https://push.example/x' }, B64) === false, 'subKeyMatches: 无 options → false');
assert(sandbox.subKeyMatches({ options: {} }, B64) === false, 'subKeyMatches: 有 options 无 applicationServerKey → false');

// ---- b. healPushRegistration（现有订阅密钥匹配当前 vapid）----
currentFakeSub = makeFakeSub(k);
calls.subscribe = 0; calls.unsubscribe = 0; calls.fetchUrls = [];
const okB = await sandbox.healPushRegistration();
assert(okB === true, 'healPushRegistration（密钥匹配）→ true', okB);
assert(calls.unsubscribe === 0, 'healPushRegistration（密钥匹配）不调用 unsubscribe', calls.unsubscribe);
assert(calls.subscribe === 0, 'healPushRegistration（密钥匹配）不调用 subscribe', calls.subscribe);
assert(calls.fetchUrls.some(u => u.indexOf('/api/register') !== -1),
  'healPushRegistration（密钥匹配）fetch 调用了 /api/register（幂等注册）', JSON.stringify(calls.fetchUrls));
assert(documentStub.getElementById('pushText').textContent === '已开启（关浏览器也响）',
  'healPushRegistration（密钥匹配）状态=已开启', documentStub.getElementById('pushText').textContent);

// ---- c. healPushRegistration（现有订阅密钥不匹配）----
currentFakeSub = makeFakeSub(diff);
calls.subscribe = 0; calls.unsubscribe = 0; calls.fetchUrls = [];
const okC = await sandbox.healPushRegistration();
assert(okC === true, 'healPushRegistration（密钥不匹配）→ true', okC);
assert(calls.unsubscribe === 1, 'healPushRegistration（密钥不匹配）先 unsubscribe 旧订阅', calls.unsubscribe);
assert(calls.subscribe === 1, 'healPushRegistration（密钥不匹配）再 subscribe 新订阅', calls.subscribe);
const newKey = currentFakeSub && currentFakeSub.options && currentFakeSub.options.applicationServerKey;
let keySame = !!newKey && newKey.length === k.length;
if (keySame) { for (let i = 0; i < k.length; i++) if (newKey[i] !== k[i]) { keySame = false; break; } }
assert(keySame, 'healPushRegistration（密钥不匹配）新订阅 applicationServerKey 与当前 vapid 公钥逐字节一致', newKey && newKey.length);

// ---- d. initPush 全流程 ----
// d1: serverOk=false + keyOk=false → 自动自愈（发生 register）且状态=已开启
server.ok = false;
currentFakeSub = makeFakeSub(diff); // 密钥不匹配 → keyOk=false
calls.subscribe = 0; calls.unsubscribe = 0; calls.fetchUrls = [];
await sandbox.initPush();
assert(calls.fetchUrls.some(u => u.indexOf('/api/sub/check') !== -1),
  'initPush 向服务端校验 clientId（/api/sub/check）', JSON.stringify(calls.fetchUrls));
assert(calls.fetchUrls.some(u => u.indexOf('/api/register') !== -1),
  'initPush（双 false）触发自动自愈：发生 /api/register', JSON.stringify(calls.fetchUrls));
assert(documentStub.getElementById('pushText').textContent === '已开启（关浏览器也响）',
  'initPush（双 false）自愈后状态=已开启', documentStub.getElementById('pushText').textContent);

// d2: serverOk=true + keyOk=true → 健康路径：不发生 unsubscribe/subscribe/register
server.ok = true;
currentFakeSub = makeFakeSub(k); // 密钥匹配 → keyOk=true
calls.subscribe = 0; calls.unsubscribe = 0; calls.fetchUrls = [];
await sandbox.initPush();
assert(calls.unsubscribe === 0 && calls.subscribe === 0,
  'initPush（双 true）不 unsubscribe/subscribe', 'unsub=' + calls.unsubscribe + ' sub=' + calls.subscribe);
assert(!calls.fetchUrls.some(u => u.indexOf('/api/register') !== -1),
  'initPush（双 true）不重复注册 /api/register', JSON.stringify(calls.fetchUrls));
assert(documentStub.getElementById('pushText').textContent === '已开启（关浏览器也响）',
  'initPush（双 true）状态=已开启', documentStub.getElementById('pushText').textContent);

// ---- e. notify 让位条件 ----
notifCalls.length = 0;
const item1 = { id: 't1', time: '07:00', label: '已同步闹钟', recurrence: 'none', timestamp: 0 };
await sandbox.syncAlarmToServer('add', item1); // fetch 桩放行 → 标记为已同步
sandbox.notify(item1);
assert(notifCalls.length === 0, 'notify: 已确认同步到服务端的闹钟让位给 Service Worker（不本地重复通知）', notifCalls.length);
const item2 = { id: 't2', time: '08:00', label: '未同步闹钟', recurrence: 'none', timestamp: 0 };
sandbox.notify(item2);
assert(notifCalls.length === 1, 'notify: 未同步（服务端无订阅）→ 本地兜底系统通知', notifCalls.length);

console.log('\n结果： ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
})();
