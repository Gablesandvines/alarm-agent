/* ============================================================
 * tests/fuzz.js —— nlu.js 的模糊测试（手写生成器，零依赖，固定种子）
 *
 * 为什么不用 Math.random()：任何一次失败都必须能原地复现。
 *   本文件用自写 LCG，种子来自 SEED 环境变量（默认 42）：
 *       SEED=42 node tests/fuzz.js
 *       SEED=1337 npm run fuzz
 *
 * 语料构造：
 *   时段词 × 数字(阿拉伯/中文/两/半) × 单位(点/点半/点N分/分钟/小时/秒)
 *   × 后缀(后/以后/之内/倒计时/的倒计时) × 干扰(提醒我/闹钟/吧/呢/量词)
 *   再叠加「混沌拼接」（随机 token 拼接、超长重复、畸形串）。
 *
 * 断言（只查性质，不查具体时刻——那是 cases.js 的事）：
 *   ① 不抛异常
 *   ② success 必须是布尔
 *   ③ success=true 时 timestamp 必须是有限整数秒
 *   ④ datetime 必须与 timestamp 描述同一瞬间
 *
 * 发现崩溃会写进 tests/fixtures/crashes/*.json 固化，防止回归。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseAlarm } = require('../nlu.js');

// ---------------------------------------------------------------- 固定种子
const SEED = Number(process.env.SEED || 42) >>> 0;
const NOW = Date.parse('2026-10-22T01:43:00Z');   // 上海 2026-10-22 09:43
const TZ = 'Asia/Shanghai';
const CRASH_DIR = path.join(__dirname, 'fixtures', 'crashes');

/** 32 位线性同余生成器（Numerical Recipes 常数）。 */
function makeLcg(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;      // [0,1)
  };
}
const rnd = makeLcg(SEED);
function pick(arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; }
function intBetween(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }

// ---------------------------------------------------------------- 词表
const TOD = ['', '凌晨', '早上', '早晨', '上午', '中午', '正午', '下午', '傍晚', '晚上', '夜里', '深夜'];
const NUM = ['0', '1', '2', '3', '5', '7', '8', '9', '10', '11', '12', '13', '20', '23', '24', '25',
  '一', '两', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '半', '三十', '五十八'];
const UNIT = ['点', '点半', '点一刻', '点三刻', '点一分', '点十八分', '点五十八分', '点钟',
  '分钟', '分', '小时', '钟头', '秒', '秒钟', '个半小时', '个半小时钟头'];
const SUFFIX = ['', '后', '以后', '之后', '之内', '以内', '倒计时', '的倒计时', '后提醒我', '后叫我'];
const NOISE = ['', '提醒我', '叫我起床', '闹钟', '吧', '呢', '啊', '一个', '帮我', '设置', '来个',
  '请输入', '的闹钟', '两个', '三点意见', '快一点', '身份证', '开会', '吃药'];
const DATEANCHOR = ['', '今天', '明天', '明早', '明晚', '后天', '大后天', '昨晚', '下周一', '本周五',
  '2025年', '2025年10月10日', '10月10日', '10号'];
const RELPRE = ['', '再过', '过了', '经过', '倒计时', '倒数', '每隔'];

// 刻意畸形
const MALFORMED = [
  '', ' ', '   ', '。', '，。！？', '……', '点', '点点点', '差差差', '分分分',
  '点半', '点分', '点分秒', '半半点', '0点', '0点半', '24点', '24点半', '25点', '99点',
  '-1点', '1.5点', '0:00', '24:00', '99:99', '1:2', '::', '12:',
  '半小时半小时半小时半小时半小时半小时', '点'.repeat(200), '差'.repeat(200),
  '十'.repeat(200), '一'.repeat(200), '每天'.repeat(200), '再过'.repeat(200),
  '99999999999999999999分钟后', '9999999999999999分钟后', '999999999999999999999秒后',
  '1'.repeat(500), '0'.repeat(500),
  '身份证45901199001011234', '一日之计在于晨', '黎明主演的电影',
  'ｆｕｌｌｗｉｄｔｈ８点', '　全角空格　', '\u0000', '\u3000', '😀😀😀', '晚上8点😀'
];

// ---------------------------------------------------------------- 语料生成
/** 结构化组合：时段 × 数字 × 单位 × 后缀 × 干扰（按 PRNG 抽样，固定种子可复现）。 */
function genStructured(n) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 40) {
    const parts = [
      pick(DATEANCHOR),
      pick(TOD),
      pick(RELPRE),
      pick(NUM),
      pick(UNIT),
      pick(SUFFIX),
      pick(NOISE)
    ];
    const s = parts.join('').trim();
    if (s) out.push(s);
  }
  return out;
}

/** 混沌拼接：随机 2–5 个 token 硬拼，制造畸形的语法。 */
function genChaos(n) {
  const pool = [].concat(TOD, NUM, UNIT, SUFFIX, NOISE, DATEANCHOR, RELPRE,
    ['点', '分', '秒', '差', '过', '零', '刻', '半', '个', ':', '：', '-', '0', '.', '年', '月', '号', '日']);
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = intBetween(2, 5);
    let s = '';
    for (let j = 0; j < k; j++) s += pick(pool);
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- 断言
let checked = 0;
const failures = [];

function check(input) {
  checked++;
  const opts = { now: NOW, tz: TZ };
  let r;
  try {
    r = parseAlarm(input, opts);
  } catch (e) {
    failures.push({ kind: 'throw', input: input, error: (e && e.name) + ': ' + (e && e.message), stack: e && e.stack });
    return;
  }
  if (typeof r.success !== 'boolean') {
    failures.push({ kind: 'success-type', input: input, error: 'success 是 ' + typeof r.success });
    return;
  }
  if (!r.success) return;
  // success 的含义随 intent 变：只有 create 才产出 alarm；
  // cancel/query/modify 成功时给的是 match（可能为空对象）。
  if (r.intent === 'create') {
    if (!r.alarm) { failures.push({ kind: 'no-alarm', input: input, error: 'create success=true 但没有 alarm' }); return; }
    const a = r.alarm;
    if (!Number.isFinite(a.timestamp) || !Number.isInteger(a.timestamp)) {
      failures.push({ kind: 'bad-timestamp', input: input, error: 'timestamp=' + a.timestamp });
      return;
    }
    const parsed = Date.parse(a.datetime);
    if (!Number.isFinite(parsed) || Math.abs(parsed / 1000 - a.timestamp) >= 0.5) {
      failures.push({
        kind: 'datetime-mismatch', input: input,
        error: 'datetime=' + a.datetime + ' timestamp=' + a.timestamp
      });
      return;
    }
  } else {
    if (r.match === undefined) {
      failures.push({ kind: 'no-match', input: input, error: 'intent=' + r.intent + ' 却没有 match' });
      return;
    }
    if (r.match && r.match.timestamp !== undefined) {
      const parsed = Date.parse(r.match.datetime);
      if (!Number.isFinite(parsed) || Math.abs(parsed / 1000 - r.match.timestamp) >= 0.5) {
        failures.push({
          kind: 'datetime-mismatch', input: input,
          error: 'match.datetime=' + r.match.datetime + ' match.timestamp=' + r.match.timestamp
        });
        return;
      }
    }
  }
  // occurrences 若存在，必须严格递增且首项等于 timestamp
  if (r.match && r.match.occurrences) {
    const occ = r.match.occurrences;
    for (let i = 1; i < occ.length; i++) {
      if (!(occ[i] > occ[i - 1])) {
        failures.push({ kind: 'occurrences', input: input, error: JSON.stringify(occ) });
        return;
      }
    }
  }
}

// ---------------------------------------------------------------- 崩溃固化
/** 稳定、可读的文件名（FNV-1a 32bit + 输入摘要）。 */
function slugOf(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const head = input.slice(0, 12).replace(/[^\w\u4e00-\u9fa5]/g, '_');
  return 'crash_' + ('00000000' + h.toString(16)).slice(-8) + '_' + (head || 'empty');
}

function persistCrash(f) {
  try {
    if (!fs.existsSync(CRASH_DIR)) fs.mkdirSync(CRASH_DIR, { recursive: true });
    const file = path.join(CRASH_DIR, slugOf(f.input) + '.json');
    if (fs.existsSync(file)) return null;         // 已是已知崩溃，不重复写
    fs.writeFileSync(file, JSON.stringify({
      input: f.input,
      opts: { now: NOW, tz: TZ },
      kind: f.kind,
      error: f.error,
      seed: SEED,
      found_at: new Date().toISOString()
    }, null, 2) + '\n');
    return file;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------- 主流程
function main() {
  const structured = genStructured(2200);
  const chaos = genChaos(400);
  const corpus = [];

  // 去重（同一句只跑一次，避免用重复样本刷数量）
  const seen = Object.create(null);
  structured.concat(chaos, MALFORMED).forEach(function (s) {
    const key = String(s);
    if (seen[key]) return;
    seen[key] = 1;
    corpus.push(key);
  });

  console.log('\n== nlu.js 模糊测试 ==');
  console.log('SEED=' + SEED + '（固定种子，可复现）');
  console.log('语料：结构化 ' + structured.length + ' + 混沌 ' + chaos.length + ' + 畸形 ' + MALFORMED.length
    + ' → 去重后 ' + corpus.length + ' 条');

  corpus.forEach(check);

  // 已知崩溃回归
  let regression = 0;
  if (fs.existsSync(CRASH_DIR)) {
    const files = fs.readdirSync(CRASH_DIR).filter(function (f) { return f.endsWith('.json'); });
    files.forEach(function (f) {
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(path.join(CRASH_DIR, f), 'utf8')); } catch (_) { return; }
      if (!rec || typeof rec.input !== 'string') return;
      const before = failures.length;
      check(rec.input);
      regression++;
      if (failures.length > before) console.log('  ✗ 历史崩溃复发：' + f);
    });
    if (files.length) console.log('历史崩溃回归：' + files.length + ' 条样本已复跑');
  }

  // 输出
  const newPersisted = [];
  failures.forEach(function (f) {
    const p = persistCrash(f);
    if (p) newPersisted.push(p);
  });

  console.log('');
  console.log('  检查样本：' + checked + ' 条' + (regression ? '（含 ' + regression + ' 条历史崩溃）' : ''));
  console.log('  不抛异常 / success 布尔 / timestamp 有限 / datetime 自洽 全部通过：'
    + (failures.length === 0 ? '是' : '否'));

  if (failures.length) {
    console.log('');
    console.log('—— 失败明细（最多 10 条）——');
    const byKind = Object.create(null);
    failures.forEach(function (f) { byKind[f.kind] = (byKind[f.kind] || 0) + 1; });
    Object.keys(byKind).forEach(function (k) { console.log('  ' + k + ': ' + byKind[k] + ' 条'); });
    failures.slice(0, 10).forEach(function (f) {
      console.log('  ✗ [' + f.kind + '] ' + JSON.stringify(f.input).slice(0, 120));
      console.log('      ' + f.error);
    });
    if (newPersisted.length) {
      console.log('');
      console.log('已固化 ' + newPersisted.length + ' 条到 tests/fixtures/crashes/：');
      newPersisted.forEach(function (p) { console.log('  + ' + path.basename(p)); });
    }
  }

  console.log('');
  console.log('结果： ' + (checked - failures.length) + ' 通过 / ' + failures.length + ' 失败');
  process.exit(failures.length ? 1 : 0);
}

main();
