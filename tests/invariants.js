/* ============================================================
 * tests/invariants.js —— nlu.js 的「性质」测试（不是逐条用例）
 *
 * 与 tests/cases.js 的分工：
 *   cases.js  ← 「这句话应该得到 20:00」这类具体期望（已有 292 条）
 *   invariants.js ← 「不管哪句话，这些性质都必须成立」这类不变量
 *
 * 目标：把「看起来没问题」变成「可证明没问题」。任何一条不变量红掉，
 *       都说明 nlu.js 内部出现了自相矛盾，而不是某个用例期望写错。
 *
 * 零依赖，只用 Node 内置。运行：node tests/invariants.js
 * ============================================================ */
'use strict';

const { parseAlarm } = require('../nlu.js');
const CASES = require('./cases.js');

// ---------------------------------------------------------------- 断言基建
let pass = 0;
const failures = [];
const perInvariant = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push({ name: name, detail: detail });
  return false;
}
function near(name, actual, expected, tol, detail) {
  return ok(name, Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    detail || `期望≈${expected}（±${tol}） 实得 ${actual}`);
}
function section(name) {
  const rec = { name: name, before: pass, fails: failures.length };
  perInvariant.push(rec);
  return rec;
}
function closeSection(rec) {
  rec.checked = pass - rec.before;
  rec.failed = failures.length - rec.fails;
}

// ---------------------------------------------------------------- 工具
const NOW = Date.parse('2026-10-22T01:43:00Z');   // 上海 2026-10-22 09:43
const TZ = 'Asia/Shanghai';

/** 独立于 nlu/scheduler 计算某 IANA 时区在 epoch 毫秒处的偏移（分钟）。 */
function tzOffsetMinutes(tz, epochMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = {};
  dtf.formatToParts(new Date(epochMs)).forEach(function (x) { p[x.type] = x.value; });
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUTC - epochMs) / 60000);
}

function optsOf(c) {
  return {
    now: c.now !== undefined ? c.now : NOW,
    tz: c.tz !== undefined ? c.tz : TZ
  };
}

// 既有 292 条语料的真实输入（只读，不改动）
const INPUTS = CASES.map(function (c) { return { input: c.input, opts: optsOf(c) }; });

/* ============================================================
 * 不变量 1：alarm.datetime 与 alarm.timestamp 描述同一个瞬间
 *   Date.parse(datetime)/1000 === timestamp
 * 这条曾经是红的：isoFor 里把秒硬写成 ":00"，相对时长类闹钟（now+30s）
 * 会出现 datetime 比 timestamp 早最多 59 秒的两字段自相矛盾。
 * ============================================================ */
(function inv1() {
  const rec = section('1 datetime/timestamp 互推自洽');
  INPUTS.forEach(function (x) {
    const r = parseAlarm(x.input, x.opts);
    if (r.alarm) {
      const a = r.alarm;
      const parsed = Date.parse(a.datetime);
      ok('1.alarm ' + x.input, Number.isFinite(parsed) && Math.abs(parsed / 1000 - a.timestamp) < 0.5,
        `${x.input} → datetime=${a.datetime} timestamp=${a.timestamp} parse/1000=${parsed / 1000}`);
      ok('1.alarm-unit ' + x.input, Number.isInteger(a.timestamp),
        `${x.input} → timestamp 不是整数秒：${a.timestamp}`);
    }
    if (r.match && r.match.datetime !== undefined) {
      const parsed = Date.parse(r.match.datetime);
      ok('1.match ' + x.input, Number.isFinite(parsed) && Math.abs(parsed / 1000 - r.match.timestamp) < 0.5,
        `${x.input} → match.datetime=${r.match.datetime} match.timestamp=${r.match.timestamp}`);
    }
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 2：同义表达归一
 *   晚上8点 / 晚上八点 / 20点 / 20:00 必须给出完全相同的 timestamp。
 *   这是「口语无所谓怎么写，语义唯一」的可证明版本。
 * ============================================================ */
(function inv2() {
  const rec = section('2 同义表达归一');
  const O = { now: NOW, tz: TZ };
  const groups = [
    {
      name: '晚上8点',
      texts: ['晚上8点提醒我', '晚上八点提醒我', '晚上8点钟提醒我', '晚上八点钟提醒我']
    },
    { name: '20点', texts: ['20点提醒我', '20:00提醒我', '20：00提醒我'] },
    { name: '下午3点', texts: ['下午3点提醒我', '下午三点提醒我', '15点提醒我', '15:00提醒我'] },
    { name: '中午1点', texts: ['中午1点提醒我', '中午一点提醒我', '13点提醒我'] },
    { name: '凌晨1点', texts: ['凌晨1点提醒我', '凌晨一点提醒我', '01:00提醒我'] },
    { name: '早上7点半', texts: ['早上7点半提醒我', '早上七点半提醒我', '7:30提醒我'] }
  ];
  groups.forEach(function (g) {
    const results = g.texts.map(function (t) { return { t: t, r: parseAlarm(t, O) }; });
    const base = results[0];
    ok('2.base ' + g.name, base.r.success === true, `${g.name} 基准句解析失败：${base.t}`);
    results.slice(1).forEach(function (x) {
      ok('2.eq ' + g.name + ' ← ' + x.t,
        x.r.success === true && base.r.success === true && x.r.alarm.timestamp === base.r.alarm.timestamp,
        `「${base.t}」→${base.r.alarm ? base.r.alarm.timestamp : 'null'} vs 「${x.t}」→${x.r.alarm ? x.r.alarm.timestamp : 'null'}`);
    });
  });
  // 供报告用：哪些口语变体其实还不支持（不算失败，只做观测）
  ['八点晚上提醒我', '20点整提醒我', '晚上8点整提醒我'].forEach(function (t) {
    const r = parseAlarm(t, O);
    if (r.success) console.log('  [观测] 支持的变体：' + t + ' → ' + r.alarm.time);
    else console.log('  [观测] 不支持的变体（已记录，不计失败）：' + t);
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 3：幂等
 *   parseAlarm(parseAlarm(t, o).raw, o) 与首次结果深度相等。
 *   （raw 是 trim 后的原文，同一 opts 下再跑一遍不应产生任何漂移）
 * ============================================================ */
(function inv3() {
  const rec = section('3 幂等');
  INPUTS.forEach(function (x) {
    const a = parseAlarm(x.input, x.opts);
    const b = parseAlarm(a.raw, x.opts);
    ok('3 ' + x.input, JSON.stringify(a) === JSON.stringify(b),
      `${x.input} → 二次解析结果不同\n    一次=${JSON.stringify(a)}\n    二次=${JSON.stringify(b)}`);
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 4：不抛异常 + success 必为布尔
 *   覆盖：既有语料 + 畸形输入（空串/纯标点/超长/越界数值/非字符串之外的脏值）
 * ============================================================ */
(function inv4() {
  const rec = section('4 不抛异常 & success 是布尔');
  const WEIRD = [
    '', ' ', '   ', '\n\t', '。', '，。！？；：', '…', '???', '!!!',
    '点点点', '差差差', '分分分', '倒计时', '再过', '点半', '点分', '半半点',
    '0点', '24点', '25点', '-1点', '99:99', '24:00', '0:0', '30:70',
    '0000000000000000000000000点', '99999999999999999999分钟后',
    '一'.repeat(300), '点'.repeat(300), '十'.repeat(300),
    '每天'.repeat(100), '明天'.repeat(100), '差五分'.repeat(100),
    '提醒我', '闹钟', '取消', '查看', '改成',
    'ｆｕｌｌｗｉｄｔｈ', '　全角空格　', '\u0000\u0001',
    '晚上8点提醒我', '倒计时30秒', '删除晚上8点的闹钟'
  ];
  WEIRD.forEach(function (t) {
    let r = null, err = null;
    try { r = parseAlarm(t, { now: NOW, tz: TZ }); } catch (e) { err = e; }
    ok('4.no-throw ' + JSON.stringify(t).slice(0, 40), err === null,
      `抛出 ${err && err.name}: ${err && err.message}`);
    if (r) ok('4.boolean ' + JSON.stringify(t).slice(0, 40), typeof r.success === 'boolean',
      `success 类型是 ${typeof r.success}`);
  });
  // success 与 needs_clarification 必须互补（不存在「成功但需澄清」的中间态）
  INPUTS.forEach(function (x) {
    const r = parseAlarm(x.input, x.opts);
    ok('4.complement ' + x.input, r.success === !r.needs_clarification,
      `${x.input} → success=${r.success} needs_clarification=${r.needs_clarification}`);
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 5：确定性
 *   同 (text, opts) 连调 3 次，结果必须深度相等（无隐藏全局状态/时间漂移）。
 * ============================================================ */
(function inv5() {
  const rec = section('5 确定性（连调 3 次）');
  INPUTS.forEach(function (x) {
    const a = parseAlarm(x.input, x.opts);
    const b = parseAlarm(x.input, x.opts);
    const c = parseAlarm(x.input, x.opts);
    const sa = JSON.stringify(a);
    ok('5 ' + x.input, sa === JSON.stringify(b) && sa === JSON.stringify(c),
      `${x.input} → 三次结果不一致`);
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 6：墙钟与 tz 解耦
 *   同一句在不同 tz 下 alarm.time（墙钟）应相同，只有 timestamp 按偏移平移。
 *   注意：必须在三地「同一天」的时刻上测，跨日会合理地改变 date。
 * ============================================================ */
(function inv6() {
  const rec = section('6 墙钟与 tz 解耦');
  const TZS = ['UTC', 'Asia/Shanghai', 'Asia/Tokyo'];
  const TEXTS = ['晚上8点提醒我', '晚上8点半提醒我', '下午3点提醒我', '明天早上8点提醒我', '每天下午2点提醒我'];
  TEXTS.forEach(function (t) {
    const base = parseAlarm(t, { now: NOW, tz: 'UTC' });
    ok('6.base ' + t, base.success === true, `${t} 在 UTC 下解析失败`);
    if (!base.success) return;
    TZS.slice(1).forEach(function (tz) {
      const r = parseAlarm(t, { now: NOW, tz: tz });
      ok('6.success ' + t + '@' + tz, r.success === true, `${t} 在 ${tz} 下解析失败`);
      if (!r.success) return;
      ok('6.wallclock ' + t + '@' + tz, r.alarm.time === base.alarm.time,
        `${t} → UTC ${base.alarm.time} vs ${tz} ${r.alarm.time}（墙钟不该随时区变）`);
      // timestamp 差值 = 两时区偏移差（等价于「同一墙钟的绝对时刻差」）
      const expectDelta = (tzOffsetMinutes(tz, base.alarm.timestamp * 1000)
        - tzOffsetMinutes('UTC', base.alarm.timestamp * 1000)) * 60;
      near('6.offset ' + t + '@' + tz, r.alarm.timestamp - base.alarm.timestamp, -expectDelta, 1,
        `${t}@${tz} → timestamp 差 ${r.alarm.timestamp - base.alarm.timestamp}s，期望 ${-expectDelta}s`);
    });
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 7：相对时长单调
 *   「X分钟后」的 (timestamp - now) 必须随 X 严格递增，且等于 60X 秒。
 * ============================================================ */
(function inv7() {
  const rec = section('7 相对时长单调');
  const XS = [1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120];
  const nowSec = Math.floor(NOW / 1000);
  let prev = -Infinity;
  XS.forEach(function (x) {
    const r = parseAlarm(x + '分钟后提醒我', { now: NOW, tz: TZ });
    ok('7.success ' + x, r.success === true, `${x}分钟后 解析失败`);
    if (!r.success) return;
    const delta = r.alarm.timestamp - nowSec;
    ok('7.strictly-increasing ' + x, delta > prev,
      `${x}分钟后 → delta=${delta}s 未大于上一档 ${prev}s`);
    prev = delta;
    ok('7.exact ' + x, delta === x * 60,
      `${x}分钟后 → delta=${delta}s，期望 ${x * 60}s`);
  });
  // 秒级同样必须精确
  [1, 30, 59, 60, 90].forEach(function (x) {
    const r = parseAlarm(x + '秒后提醒我', { now: NOW, tz: TZ });
    if (!r.success) { ok('7.sec ' + x, false, `${x}秒后 解析失败`); return; }
    ok('7.sec ' + x, r.alarm.timestamp - nowSec === x, `${x}秒后 → delta=${r.alarm.timestamp - nowSec}s`);
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 8：值域
 *   time 必须 0≤HH≤23、0≤MM≤59；date 必须是 YYYY-MM-DD；recurrence 必须在枚举内；
 *   timestamp 必须落在合理历史区间，且「非显式年份」的单次闹钟落在 [now-2y, now+2y]。
 * ============================================================ */
(function inv8() {
  const rec = section('8 值域');
  const REC_ENUM = ['none', 'daily', 'weekdays', 'weekend'];
  const ABS_MIN = Date.UTC(2000, 0, 1) / 1000;
  const ABS_MAX = Date.UTC(2100, 0, 1) / 1000;
  const TWO_Y = 2 * 365 * 86400;
  INPUTS.forEach(function (x) {
    const r = parseAlarm(x.input, x.opts);
    if (!r.alarm) return;
    const a = r.alarm;
    const m = /^(\d{2}):(\d{2})$/.exec(a.time);
    ok('8.time-format ' + x.input, m !== null, `${x.input} → time="${a.time}" 不是 HH:MM`);
    if (m) {
      const hh = +m[1], mm = +m[2];
      ok('8.time-range ' + x.input, hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59,
        `${x.input} → time="${a.time}" 越界`);
    }
    ok('8.date-format ' + x.input, /^\d{4}-\d{2}-\d{2}$/.test(a.date || ''),
      `${x.input} → date="${a.date}"`);
    ok('8.recurrence ' + x.input,
      REC_ENUM.indexOf(a.recurrence) >= 0 || /^(weekly|every|biweekly|monthly):\d+$/.test(a.recurrence),
      `${x.input} → recurrence="${a.recurrence}" 不在枚举内`);
    ok('8.ts-absolute ' + x.input, a.timestamp >= ABS_MIN && a.timestamp <= ABS_MAX,
      `${x.input} → timestamp=${a.timestamp} 超出 2000–2100`);
    // 显式写了 4 位年份的句子允许落在远处（如「2018年7月19号」），其余不准飘出 ±2 年
    if (!/\d{4}\s*年/.test(x.input) && a.recurrence === 'none') {
      const nowSec = Math.floor((x.opts.now) / 1000);
      ok('8.ts-near ' + x.input,
        Math.abs(a.timestamp - nowSec) <= TWO_Y,
        `${x.input} → timestamp 距 now ${Math.round((a.timestamp - nowSec) / 86400)} 天，超出 ±2 年`);
    }
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 9：label 洁净
 *   解析成功时，label 不得包含「时段词」或「时刻串」——这些信息已被
 *   alarm.time / alarm.date 结构化吸收，残留在 label 里既是噪音，
 *   也会让前端按 label 过滤时误命中。
 *
 *   白名单规则（写清，避免后人乱加）：
 *     只有当该字/词是用户表达**正文语义**的一部分、且不构成时刻时，才允许出现在
 *     label 里，并必须登记到 LABEL_ALLOW（整词精确比对，不做前缀匹配）。
 *     当前语料实测 0 例外，机制保留备用。
 * ============================================================ */
(function inv9() {
  const rec = section('9 label 洁净');
  const LABEL_ALLOW = [];   // 例：['点心', '有点忙']
  // 时刻串：数字+点 / HH:MM
  const CLOCK_IN_LABEL = /\d{1,2}\s*点|\d{1,2}\s*[:：]\s*\d{1,2}/;
  // 时段词（与 resolveClock 的时段表同源）
  const TOD_IN_LABEL = /凌晨|拂晓|早上|早晨|上午|清早|中午|正午|下午|傍晚|黄昏|晚上|夜里|夜晚|深夜/;

  function allowed(text) {
    return LABEL_ALLOW.some(function (w) { return text.indexOf(w) >= 0; });
  }
  function check(kind, input, label) {
    if (!label || label === '(无备注)') return;
    if (allowed(label)) return;
    ok('9.' + kind + '-clock ' + input, !CLOCK_IN_LABEL.test(label),
      `${input} → ${kind}.label="${label}" 残留时刻串`);
    ok('9.' + kind + '-tod ' + input, !TOD_IN_LABEL.test(label),
      `${input} → ${kind}.label="${label}" 残留时段词`);
  }
  INPUTS.forEach(function (x) {
    const r = parseAlarm(x.input, x.opts);
    if (r.alarm) check('alarm', x.input, r.alarm.label);
    if (r.match) check('match', x.input, r.match.label);
    if (r.update) check('update', x.input, r.update.label);
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 10：候选集（occurrences）
 *   存在时：长度 ≤3、严格递增、首项 === timestamp、全部为整数秒。
 * ============================================================ */
(function inv10() {
  const rec = section('10 候选集 occurrences');
  INPUTS.forEach(function (x) {
    const r = parseAlarm(x.input, x.opts);
    const occ = r.match && r.match.occurrences;
    if (!occ) return;
    ok('10.len ' + x.input, Array.isArray(occ) && occ.length >= 1 && occ.length <= 3,
      `${x.input} → occurrences 长度 ${occ && occ.length}`);
    ok('10.first ' + x.input, occ[0] === r.match.timestamp,
      `${x.input} → occurrences[0]=${occ[0]} ≠ timestamp=${r.match.timestamp}`);
    let increasing = true;
    for (let i = 1; i < occ.length; i++) if (!(occ[i] > occ[i - 1])) increasing = false;
    ok('10.increasing ' + x.input, increasing, `${x.input} → occurrences 非严格递增：${JSON.stringify(occ)}`);
    ok('10.int ' + x.input, occ.every(function (v) { return Number.isInteger(v); }),
      `${x.input} → occurrences 含非整数：${JSON.stringify(occ)}`);
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 11：lead（提前提醒）不会把 timestamp 推到未来之外
 *   lead_minutes ≥ 0 且触发时刻 = 墙钟时刻 − lead，绝不为负。
 * ============================================================ */
(function inv11() {
  const rec = section('11 lead 非负且不越界');
  INPUTS.forEach(function (x) {
    const r = parseAlarm(x.input, x.opts);
    if (!r.alarm) return;
    const a = r.alarm;
    ok('11.lead-nonneg ' + x.input, a.lead_minutes >= 0 && Number.isInteger(a.lead_minutes),
      `${x.input} → lead_minutes=${a.lead_minutes}`);
    if (a.lead_minutes > 0) {
      const parsed = Date.parse(a.datetime);
      // datetime 已扣掉 lead，必须仍能反解成 timestamp
      ok('11.lead-consistent ' + x.input, Math.abs(parsed / 1000 - a.timestamp) < 0.5,
        `${x.input} → lead=${a.lead_minutes} 时 datetime/timestamp 不自洽`);
    }
  });
  closeSection(rec);
})();

/* ============================================================
 * 不变量 12：intent 与返回字段自洽
 *   create 必带 alarm（或带 clarification）；cancel/query/modify 必带 match（可为空对象）；
 *   modify 成功时必带 update。
 * ============================================================ */
(function inv12() {
  const rec = section('12 intent 与字段自洽');
  const INTENTS = ['create', 'cancel', 'query', 'modify'];
  INPUTS.forEach(function (x) {
    const r = parseAlarm(x.input, x.opts);
    ok('12.intent ' + x.input, INTENTS.indexOf(r.intent) >= 0, `${x.input} → intent="${r.intent}" 非法`);
    ok('12.raw ' + x.input, typeof r.raw === 'string' && r.raw === String(x.input).trim(),
      `${x.input} → raw="${r.raw}" 与输入不符`);
    if (r.intent === 'create') {
      ok('12.create ' + x.input, r.success ? !!r.alarm : !!r.clarification,
        `${x.input} → create 成功却无 alarm / 失败却无 clarification`);
    } else {
      ok('12.match ' + x.input, r.match !== undefined, `${x.input} → intent=${r.intent} 却没有 match`);
      if (r.intent === 'modify' && r.success) {
        ok('12.update ' + x.input, r.update && Object.keys(r.update).length > 0,
          `${x.input} → modify 成功却没有 update`);
      }
    }
  });
  closeSection(rec);
})();

/* ============================================================ 汇总 */
console.log('\n== nlu.js 不变量套件 ==');
console.log('语料：' + INPUTS.length + ' 条既有用例 + 内置畸形输入');
console.log('');
perInvariant.forEach(function (r) {
  const flag = r.failed ? '✗' : '✓';
  console.log(`  ${flag} ${r.name.padEnd(34, ' ')} ${String(r.checked).padStart(4, ' ')} 通过` +
    (r.failed ? `  / ${r.failed} 失败` : ''));
});
console.log('');
if (failures.length) {
  console.log('—— 失败明细（最多 20 条）——');
  failures.slice(0, 20).forEach(function (f) {
    console.log('  ✗ ' + f.name);
    if (f.detail) console.log('      ' + String(f.detail).replace(/\n/g, '\n      '));
  });
  if (failures.length > 20) console.log('  … 其余 ' + (failures.length - 20) + ' 条略');
  console.log('');
}
console.log(`结果： ${pass} 通过 / ${failures.length} 失败`);
process.exit(failures.length ? 1 : 0);
