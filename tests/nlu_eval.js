/* ============================================================
 * tests/nlu_eval.js — fst-time-nlu 语料评测（严格金标准评测，非 npm test 门禁）
 *
 * 用法：node tests/nlu_eval.js
 *   输入 ① tests/fixtures/fst_time_nlu_zh.jsonl  —— 语料全集（分母来源）
 *        ② tests/fixtures/gold.jsonl             —— 严格金标准（可评子集 + 期望值）
 *        ③ docs/unsupported.md                   —— 不可评子集的裁决理由（OUT_OF_SCOPE 反查表）
 *   产出：docs/nlu_eval_report.md + 终端摘要
 *
 * 为什么要有 gold.jsonl：
 *   语料 338 条里，绝大部分是「检索/日程问答」场景的时间**区间**（整日、时段、跨月跨度），
 *   与「闹钟只需要一个触发时刻」不同构。直接把这类样本判成「不可比」会让分母缩到几十条，
 *   而给出的百分比没有任何意义（旧版报告正是因为只有 46 条分母才出现「93%」）。
 *   因此本轮把 288 条 OUT_OF_SCOPE 逐条裁决成两类：
 *     · 可评  → tests/fixtures/gold.jsonl（200 条，期望值只来自语料标注 + 独立手算）
 *     · 不可评 → docs/unsupported.md（138 条，带固定类别与理由）
 *
 * 反循环论证（本文件的核心约束）：
 *   gold.jsonl 的期望值**不得**由 parseAlarm 的输出反推。
 *   期望值只有两个来源：
 *     ① 语料自带标注 datetime_result（日期 / 墙钟 / 相对时长起点）；
 *     ② 独立手算（时间戳用纯 Date.UTC + 固定 +08:00 算，绝不经 scheduler.wallToEpoch）。
 *   本文件只做「读 gold → 跑实现 → 比对」，不参与任何期望值的生成。
 *
 * 比较口径（gold 每条自带 strict 列表，只比列表里的字段）：
 *   kind=abs        有日锚点 → 比 intent + 日历日 + 墙钟 HH:MM
 *   kind=wall       无日锚点/语料日属"过去日期"约定 → 只比 intent + 墙钟 HH:MM
 *   kind=date       纯日期（整日区间）→ 比日历日，且 time 必须为 null（缺时刻应追问，不许凭空给）
 *   kind=rel        相对时长 → 比 intent + elapsed 秒（与墙钟无关）
 *   kind=recurrence 只有重复规则 → 比 intent + recurrence，且 time 必须为 null
 *   kind=none       语料标注为空（负例）→ time 必须为 null（给出时刻即误报）
 *
 * 五分类（每条样本只归一类，按判定优先级自上而下）：
 *   OUT_OF_SCOPE    无 gold（在 docs/unsupported.md 里有且仅有一行）→ 不参与分母
 *   NOT_COMPARABLE  意图不一致（我方判成 cancel/query/modify），时刻字段不可比
 *   MISSED          期望有时刻，我方没给
 *   SUSPECT         期望没有时刻，我方却给了（误报）
 *   DIFF            双方都有值但不一致
 *   PASS            strict 字段全部一致
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseAlarm } = require('../nlu.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'fst_time_nlu_zh.jsonl');
const GOLD = path.join(__dirname, 'fixtures', 'gold.jsonl');
const UNSUPPORTED_MD = path.join(__dirname, '..', 'docs', 'unsupported.md');
const OUT_MD = path.join(__dirname, '..', 'docs', 'nlu_eval_report.md');
const TZ = 'Asia/Shanghai';
const TOL_S = 60;              // 相对时长容差（秒）
const TOP_N = 20;

/* 分类维度（报告里的 precision / recall 按这套口径拆） */
const CATS = ['时段×时刻', '相对时长', '重复规则', '日期锚点', '过差零', '倒计时', 'label 抽取'];
const EXTRA_CATS = ['负例'];    // 不属于上面 7 类，专门度量 precision（该给不给 / 不该给却给）

/* ---------------- 装载 ---------------- */

/**
 * 读取 JSONL 语料。
 * @param {string} file 文件路径
 * @return {Array<Object>} 行对象数组（损坏行带 __broken）
 */
function loadJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const rows = [];
  raw.split(/\r?\n/).forEach(function (line) {
    const s = line.trim();
    if (!s) return;
    try {
      rows.push(JSON.parse(s));
    } catch (e) {
      rows.push({ __broken: s });
    }
  });
  return rows;
}

function loadCorpus() {
  return loadJsonl(FIXTURE);
}

/**
 * 读取金标准，返回 source_line → 条目 的映射。
 * @return {Map<number, Object>}
 */
function loadGold() {
  const map = new Map();
  if (!fs.existsSync(GOLD)) return map;
  loadJsonl(GOLD).forEach(function (g) {
    if (!g || g.__broken || !g.source_line) return;
    map.set(g.source_line, g);
  });
  return map;
}

/**
 * 解析 docs/unsupported.md 的表格，返回 source_line → 类别。
 * @return {Map<number, string>}
 */
function loadUnsupported() {
  const map = new Map();
  if (!fs.existsSync(UNSUPPORTED_MD)) return map;
  fs.readFileSync(UNSUPPORTED_MD, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (!m) return;
    map.set(parseInt(m[1], 10), m[3].trim());
  });
  return map;
}

/* ---------------- 取值归一 ---------------- */

/**
 * 把我方解析结果归一成「可与 gold 直接比对」的字段集合。
 * @param {Object} res parseAlarm 返回值
 * @param {number} baseMs 该条的基准时间（= metadata）
 * @return {{intent:string, date:?string, time:?string, recurrence:?string, label:?string, elapsed_s:?number}}
 */
function ourFields(res, baseMs) {
  const a = (res && res.alarm) || null;
  /* cancel / query / modify 不产出 alarm，时刻在 match 里（产品契约：nlu 只给结构化指令） */
  const m = (res && res.match) || null;
  const time = (a && a.time) || (m && m.time) || null;
  const date = (a && a.date) || (m && m.date) || (res && res.date) || null;
  let elapsed = null;
  if (a && typeof a.timestamp === 'number') {
    elapsed = Math.round((a.timestamp * 1000 - baseMs) / 1000);
  }
  let label = (a && a.label) || (m && m.label) || null;
  if (label === '(无备注)') label = null;
  return {
    intent: (res && res.intent) || 'create',
    date: date,
    time: time,
    recurrence: (a && a.recurrence) || (m && m.recurrence) || null,
    label: label,
    elapsed_s: elapsed
  };
}

/* ---------------- 单条比对 ---------------- */

/**
 * 按 gold 的 strict 列表逐字段比对。
 * @param {Object} g gold 条目
 * @param {Object} our ourFields 的产物
 * @return {{ok:boolean, diffs:Array<string>}}
 */
function compareStrict(g, our) {
  const diffs = [];
  g.strict.forEach(function (k) {
    const want = g.expect[k];
    const got = our[k];
    if (k === 'elapsed_s') {
      if (want === null || want === undefined) return;
      if (got === null) { diffs.push('elapsed_s 期望 ' + want + 's，我方无时刻'); return; }
      if (Math.abs(got - want) > TOL_S) diffs.push('elapsed_s 期望 ' + want + 's，实得 ' + got + 's');
      return;
    }
    if (want === null) {
      if (got !== null) diffs.push(k + ' 期望 null，实得 ' + JSON.stringify(got));
      return;
    }
    if (got !== want) diffs.push(k + ' 期望 ' + JSON.stringify(want) + '，实得 ' + JSON.stringify(got));
  });
  return { ok: diffs.length === 0, diffs: diffs };
}

/* ---------------- 主评测 ---------------- */

/**
 * 逐条评测语料，并断言 OUT_OF_SCOPE 与 docs/unsupported.md 一一对应。
 * @return {{rows:Array, stats:Object, buckets:Object, catStats:Object, assertion:Object}}
 */
function evaluate() {
  const corpus = loadCorpus();
  const gold = loadGold();
  const unsup = loadUnsupported();

  const buckets = {
    OUT_OF_SCOPE: [],
    MISSED: [],
    SUSPECT: [],
    DIFF: [],
    PASS: [],
    NOT_COMPARABLE: []
  };
  const rows = [];
  const stats = {
    total: 0,
    broken: 0,
    gold: 0,
    outOfScope: 0,
    ourTimeFilled: 0,
    ourClarify: 0,
    goldSrcCorpus: 0,
    goldSrcHand: 0
  };
  const assertion = { ok: true, problems: [] };

  corpus.forEach(function (item, idx) {
    const line = idx + 1;
    if (item.__broken) { stats.broken++; return; }
    stats.total++;

    const g = gold.get(line);
    const baseMs = Date.parse(item.metadata);
    let res;
    try {
      res = parseAlarm(item.query || '', { now: isNaN(baseMs) ? Date.now() : baseMs, tz: TZ });
    } catch (e) {
      res = { success: false, intent: 'create', alarm: null, needs_clarification: true, __error: String((e && e.message) || e) };
    }
    const our = ourFields(res, baseMs);
    if (our.time) stats.ourTimeFilled++;
    if (res && res.needs_clarification) stats.ourClarify++;

    const row = {
      idx: line,
      query: item.query || '',
      metadata: item.metadata,
      expected: g ? renderExpect(g) : '（不支持严格比较）',
      cat: g ? g.cat : (unsup.get(line) || '（未登记）'),
      ours: our.time ? (our.date + ' ' + our.time) : '（无时刻）',
      ourIntent: our.intent,
      ourError: (res && res.__error) || null,
      note: (g && g.note) || '',
      pastConvention: !!(g && g.meta && g.meta.past_convention)
    };

    if (!g) {
      /* 无 gold → OUT_OF_SCOPE；必须能在 docs/unsupported.md 反查到 */
      stats.outOfScope++;
      row.cat = 'OUT_OF_SCOPE';
      row.reason = unsup.has(line)
        ? ('语料不可评（' + unsup.get(line) + '），理由见 docs/unsupported.md')
        : '⚠ 未在 docs/unsupported.md 登记';
      if (!unsup.has(line)) {
        assertion.ok = false;
        assertion.problems.push('第 ' + line + ' 行判为 OUT_OF_SCOPE，但 docs/unsupported.md 里没有对应行');
      }
      row.cls = 'OUT_OF_SCOPE';
      rows.push(row);
      buckets.OUT_OF_SCOPE.push(row);
      return;
    }

    stats.gold++;
    if (g.src === 'corpus+hand') stats.goldSrcHand++; else stats.goldSrcCorpus++;

    /* 分类：先看 intent（只有 strict 含 intent 时才比），再看时刻有无，最后跑 strict 比对 */
    const expTime = g.expect.time;
    const strictTime = g.strict.indexOf('time') >= 0;
    const strictIntent = g.strict.indexOf('intent') >= 0;
    let cls, reason;
    if (strictIntent && our.intent !== g.expect.intent) {
      cls = 'NOT_COMPARABLE';
      reason = '意图不一致（期望 ' + g.expect.intent + ' / 我方 ' + our.intent + '）';
    } else if (strictTime && expTime !== null && expTime !== undefined && our.time === null) {
      cls = 'MISSED';
      reason = '期望时刻 ' + expTime + '，我方未给出';
    } else if (strictTime && (expTime === null || expTime === undefined) && our.time !== null) {
      cls = 'SUSPECT';
      reason = '该句不应有具体时刻，我方却给出 ' + our.time + '（误报）';
    } else {
      const cmp = compareStrict(g, our);
      if (cmp.ok) { cls = 'PASS'; reason = 'strict 字段一致'; }
      else { cls = 'DIFF'; reason = cmp.diffs.join('；'); }
    }

    row.cls = cls;
    row.reason = reason;
    row.missedFields = (cls === 'DIFF') ? compareStrict(g, our).diffs : [];
    row.root = rootCause(row);
    rows.push(row);
    buckets[cls].push(row);
  });

  /* 反向断言：unsupported.md 里登记的行不能在 gold 里；两边条数要对得上 */
  if (gold.size + unsup.size !== stats.total) {
    assertion.ok = false;
    assertion.problems.push('gold(' + gold.size + ') + unsupported(' + unsup.size
      + ') = ' + (gold.size + unsup.size) + '，与语料 ' + stats.total + ' 条不一致');
  }
  gold.forEach(function (g, line) {
    if (unsup.has(line)) {
      assertion.ok = false;
      assertion.problems.push('第 ' + line + ' 行同时出现在 gold.jsonl 与 docs/unsupported.md');
    }
  });
  unsup.forEach(function (cat, line) {
    if (line < 1 || line > stats.total) {
      assertion.ok = false;
      assertion.problems.push('docs/unsupported.md 登记了不存在的行号 ' + line);
    }
  });
  if (stats.outOfScope !== unsup.size) {
    assertion.ok = false;
    assertion.problems.push('OUT_OF_SCOPE ' + stats.outOfScope + ' 条，但 docs/unsupported.md 登记 ' + unsup.size + ' 条');
  }

  /* 分类统计（多轴：label 抽取是正交的额外断言） */
  const catStats = {};
  CATS.concat(EXTRA_CATS).forEach(function (c) {
    catStats[c] = { n: 0, pass: 0, diff: 0, missed: 0, suspect: 0, notComparable: 0, pastConvention: 0 };
  });
  rows.forEach(function (r) {
    if (r.cls === 'OUT_OF_SCOPE') return;
    const g = gold.get(r.idx);
    /* 语义类别轴 */
    const t = catStats[r.cat];
    if (t) { t.n++; t[clsKey(r.cls)]++; if (r.pastConvention) t.pastConvention++; }
    /* label 抽取 是正交轴：带 label 断言的样本额外计一次 */
    if (g && g.strict.indexOf('label') >= 0) {
      const l = catStats['label 抽取'];
      l.n++; l[clsKey(r.cls)]++;
    }
  });

  return { rows: rows, stats: stats, buckets: buckets, catStats: catStats, assertion: assertion };
}

function clsKey(cls) {
  return {
    PASS: 'pass', DIFF: 'diff', MISSED: 'missed', SUSPECT: 'suspect', NOT_COMPARABLE: 'notComparable'
  }[cls];
}

/**
 * 把失败样本归到「根因桶」，便于按影响条数排优先级。
 * 规则是显式的：只看 query 的词面特征 + 哪个字段不一致，不做任何语义推断。
 * @param {{cls:string, query:string, missedFields:?Array<string>}} row
 * @return {string} 根因桶名；PASS 返回 ''
 */
function rootCause(row) {
  if (row.cls === 'PASS' || row.cls === 'OUT_OF_SCOPE') return '';
  if (row.cls === 'SUSPECT') return '误报：裸小数/量词「点」仍出行时刻';
  const q = row.query;
  const d = (row.missedFields || []).join(' ');
  if (/每个周|每个星期|每个礼拜/.test(q)) return '「每个周X」重复规则未识别';
  if (/\d+\s*年后|\d+\s*年前/.test(q)) return '「N年后」日期增量未支持';
  if (/去年|前年|之前|上一/.test(q) && /节|中秋|除夕|端午|重阳|国庆|元旦/.test(q)) return '「去年/前年 + 节日」未回退年份';
  if (/初一|初九|初十|十五|廿|腊月|正月|农历|阴历/.test(q)) return '农历日期未支持';
  if (/date 期望 .*实得 null/.test(d)) return '纯日期（明天/周X/节日）无时刻时 `date` 字段丢失';
  if (/\d{4}\s*年/.test(q) && /date 期望/.test(d)) return '显式年份被忽略（2019年 → 2025年）';
  if (row.pastConvention) return '过去日期：语料记"基准日之前"，我方顺延到未来（约定差）';
  if (/节|清明|中秋|除夕|端午|重阳|国庆|元旦/.test(q)) return '节日/节气日期偏差';
  if (/label/.test(d)) return 'label 残留：标点/疑问句未剥离';
  if (/time 期望 "00:00"/.test(d)) return '「晚上12点」算成 12:00（应为 00:00）';
  return '其它：' + d.slice(0, 60);
}

/** 把 gold 的期望渲染成一行可读文本 */
function renderExpect(g) {
  const e = g.expect;
  if (g.kind === 'rel') return '相对时长 +' + e.elapsed_s + 's';
  if (g.kind === 'date') return e.date + '（纯日期，无时刻）';
  if (g.kind === 'recurrence') return 'recurrence=' + e.recurrence + '（无时刻）';
  if (g.kind === 'none') return '（负例：不应有时刻）';
  if (g.kind === 'abs') return e.date + ' ' + e.time;
  return e.time;
}

/* ---------------- 报告渲染 ---------------- */

const CAT_ORDER = ['PASS', 'DIFF', 'MISSED', 'SUSPECT', 'NOT_COMPARABLE', 'OUT_OF_SCOPE'];
const CAT_DESC = {
  PASS: 'strict 字段全部一致',
  DIFF: '双方都有值但不一致（真差异）',
  MISSED: '期望有时刻，我方没给（真缺口）',
  SUSPECT: '该句不应有具体时刻，我方却给了（误报）',
  NOT_COMPARABLE: '意图不一致，时刻字段不可比（cancel/query/modify vs create）',
  OUT_OF_SCOPE: '语料不可严格比较（区间/多候选/世纪/自相矛盾），理由见 docs/unsupported.md'
};

function mdEscape(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function pct(a, b) {
  if (!b) return '—';
  return (a * 100 / b).toFixed(1) + '%';
}

/**
 * 渲染完整 Markdown 报告。
 * @param {{rows:Array, stats:Object, buckets:Object, catStats:Object, assertion:Object}} r
 * @return {string}
 */
function renderReport(r) {
  const s = r.stats;
  const b = r.buckets;
  const cs = r.catStats;
  const good = b.PASS.length;
  const L = [];

  /* 第一行必须是真实分母 —— 不允许出现不带分母的百分比 */
  L.push('**严格可评 ' + s.gold + ' 条 / 语料总数 ' + s.total + ' 条（' + pct(s.gold, s.total) + '）；'
    + '真实一致率 ' + good + '/' + s.gold + ' = ' + pct(good, s.gold) + '。**');
  L.push('');
  L.push('# NLU 语料评测报告（fst-time-nlu · 严格金标准）');
  L.push('');
  L.push('> 本文件由 `node tests/nlu_eval.js` 自动生成，请勿手工编辑。');
  L.push('> 语料：`tests/fixtures/fst_time_nlu_zh.jsonl`（' + s.total + ' 条，OPPO **fst-time-nlu**，Apache-2.0，见 `tests/fixtures/NOTICE.md`）。');
  L.push('> 金标准：`tests/fixtures/gold.jsonl`（' + s.gold + ' 条）；不可评清单：`docs/unsupported.md`（' + s.outOfScope + ' 条）。');
  L.push('> 解析参数：`opts.now = Date.parse(metadata)`，`opts.tz = \'' + TZ + '\'`，可重复运行。');
  L.push('');

  L.push('## 一、分母是怎么来的');
  L.push('');
  L.push('语料 ' + s.total + ' 条里，旧版评测只让 **46 条**进了严格比较，其余 **288 条**一律判 `OUT_OF_SCOPE` 后');
  L.push('**从分母里消失**——旧报告里那个「93%」的分母其实就是这 46 条，属于典型的幸存者偏差。');
  L.push('本轮把这 288 条（连同判成「语料无期望」的 4 条误报样本，共 292 条）逐条裁决，不留白：');
  L.push('');
  L.push('| 裁决结果 | 条数 | 去向 |');
  L.push('| --- | --- | --- |');
  L.push('| 原有可评样本（沿用） | 46 | 其中 2 条因语料日期自相矛盾降级为「只比钟点」 |');
  L.push('| 整日区间 → 纯日期比对 | 103 | 语料标注为 `00:00:00Z~23:59:59Z` 单日 → 语义就是一个日历日 |');
  L.push('| 单点 `00:00:00` → 时刻/日期 | 3 | 「零点」「晚上12点」「ISO 串」 |');
  L.push('| 语料标注为空 → 负例 | 47 | 该句不含时间表达式，不得凭空产出时刻 |');
  L.push('| 语料标注为空 → 重复规则 | 1 | 「每个周一」= `weekly:1` |');
  L.push('| 仍不可比较 | 138 | `docs/unsupported.md`（区间 / 多候选 / 世纪） |');
  L.push('| 合计 | ' + s.total + ' | 与语料 ' + s.total + ' 条一致'
    + (r.assertion.ok ? ' ✅' : ' ❌') + ' |');
  L.push('');
  L.push('注意：`纯日期无时刻` 这一类**没有**被丢进 unsupported，而是转成「只比日历日、且 `time` 必须为 null」的');
  L.push('严格断言——因为「日期对了但凭空给了个时刻」和「日期错了」都是必须被抓住的错，丢掉太浪费。');
  L.push('**期望值来源（反循环论证）**：`gold.jsonl` 的期望**不是**从 `parseAlarm` 输出抄的。');
  L.push('日期/墙钟/相对时长起点全部取自语料自带标注 `datetime_result`；时间戳用 `Date.UTC(y, mo-1, d, H-8, M)` 独立手算');
  L.push('（Asia/Shanghai 固定 +08:00，无夏令时，不经 `scheduler.wallToEpoch`）。');
  L.push('');
  L.push('| 期望来源 | 条数 |');
  L.push('| --- | --- |');
  L.push('| 语料自带标注（`src: corpus`） | ' + s.goldSrcCorpus + ' |');
  L.push('| 语料标注 + 独立手算（`src: corpus+hand`，含 `label` / `recurrence` 的独立判定） | ' + s.goldSrcHand + ' |');
  L.push('');
  L.push('比较口径按 `kind` 分档（每条 gold 自带 `strict` 列表，只比列表里的字段）：');
  L.push('');
  L.push('| kind | 语义 | 比什么 |');
  L.push('| --- | --- | --- |');
  L.push('| `abs` | 有日锚点的单点钟点 | `intent` + 日历日 + 墙钟 `HH:MM` |');
  L.push('| `wall` | 无日锚点（或语料日属"过去日期"约定） | `intent` + 墙钟 `HH:MM` |');
  L.push('| `date` | 纯日期（语料整日区间） | 日历日 + `time` 必须为 `null` |');
  L.push('| `rel` | 相对时长 | `intent` + `elapsed` 秒（±' + TOL_S + 's） |');
  L.push('| `recurrence` | 只有重复规则 | `intent` + `recurrence` + `time` 必须为 `null` |');
  L.push('| `none` | 语料标注为空（负例） | `time` 必须为 `null` |');
  L.push('');

  L.push('## 二、五分类计数');
  L.push('');
  L.push('| 分类 | 条数 | 占语料 | 占可评 | 含义 |');
  L.push('| --- | --- | --- | --- | --- |');
  CAT_ORDER.forEach(function (c) {
    const n = b[c].length;
    const base = (c === 'OUT_OF_SCOPE') ? s.total : s.gold;
    L.push('| `' + c + '` | ' + n + ' | ' + pct(n, s.total) + ' | ' + pct(n, base) + ' | ' + CAT_DESC[c] + ' |');
  });
  L.push('');
  L.push('`OUT_OF_SCOPE` 反查断言：' + s.outOfScope + ' 条 / `docs/unsupported.md` ' + s.outOfScope + ' 行 — **'
    + (r.assertion.ok ? '通过' : '失败') + '**');
  if (!r.assertion.ok) {
    L.push('');
    r.assertion.problems.forEach(function (p) { L.push('- ❌ ' + p); });
  }
  L.push('');

  L.push('## 三、分类 precision / recall');
  L.push('');
  L.push('口径：`n` = 该类 gold 条数；`正确` = PASS；`召回` = 正确 / n；');
  L.push('`精度` = 正确 / (正确 + DIFF + SUSPECT)，即「我方真的给出了值」的那些行里对的比例（MISSED 与 NOT_COMPARABLE 不进精度分母）。');
  L.push('`label 抽取` 是正交轴：带 `label` 断言的样本会同时计入自身语义类别与本行。');
  L.push('');
  L.push('| 类别 | n | 正确 | 错误 | 召回 | 精度 | MISSED | SUSPECT | DIFF | 不可比 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  CATS.concat(EXTRA_CATS).forEach(function (c) {
    const t = cs[c];
    const wrong = t.n - t.pass;
    const precDen = t.pass + t.diff + t.suspect;
    L.push('| ' + c + ' | ' + t.n + ' | ' + t.pass + ' | ' + wrong + ' | ' + pct(t.pass, t.n)
      + ' | ' + (precDen ? pct(t.pass, precDen) : '—')
      + ' | ' + t.missed + ' | ' + t.suspect + ' | ' + t.diff + ' | ' + t.notComparable + ' |');
  });
  L.push('');
  L.push('> `倒计时` 一类在本语料里 n=0（语料无「倒计时/倒数」表达），该能力由 `tests/cases.js` 的用例覆盖。');
  L.push('> `负例` 不属于上面 7 类，专门用来度量「不该给时刻却给了」的误报，因此它的精度口径 = 正确 / n。');
  L.push('');

  L.push('## 四、错误明细（MISSED / SUSPECT / DIFF 全量）');
  L.push('');
  ['MISSED', 'SUSPECT', 'DIFF', 'NOT_COMPARABLE'].forEach(function (c) {
    const list = b[c];
    L.push('### ' + c + '（' + list.length + ' 条）');
    L.push('');
    if (!list.length) { L.push('_无_'); L.push(''); return; }
    L.push('| 行号 | query | 期望 | 我方 | 差异 |');
    L.push('| --- | --- | --- | --- | --- |');
    list.forEach(function (x) {
      L.push('| ' + x.idx + ' | ' + mdEscape(x.query) + ' | ' + mdEscape(x.expected)
        + ' | ' + mdEscape(x.ours) + ' | ' + mdEscape(x.reason) + ' |');
    });
    L.push('');
  });

  L.push('## 五、一致性抽样（PASS 前 ' + TOP_N + ' 条）');
  L.push('');
  L.push('| 行号 | query | 期望 | 我方 |');
  L.push('| --- | --- | --- | --- |');
  b.PASS.slice(0, TOP_N).forEach(function (x) {
    L.push('| ' + x.idx + ' | ' + mdEscape(x.query) + ' | ' + mdEscape(x.expected) + ' | ' + mdEscape(x.ours) + ' |');
  });
  if (b.PASS.length > TOP_N) L.push('| … | _其余 ' + (b.PASS.length - TOP_N) + ' 条略_ | | |');
  L.push('');

  L.push('## 六、失败根因归类（按影响 gold 条数排序）');
  L.push('');
  L.push('只统计非 PASS 的可评样本；同一根因桶内的行号可回查上一节的明细。');
  L.push('');
  const roots = {};
  r.rows.forEach(function (x) {
    if (!x.root) return;
    if (!roots[x.root]) roots[x.root] = [];
    roots[x.root].push(x.idx);
  });
  const sorted = Object.keys(roots).sort(function (a, z) { return roots[z].length - roots[a].length; });
  L.push('| 根因 | 影响条数 | 行号 |');
  L.push('| --- | --- | --- |');
  sorted.forEach(function (k) {
    const ids = roots[k];
    L.push('| ' + mdEscape(k) + ' | ' + ids.length + ' | '
      + (ids.length > 12 ? ids.slice(0, 12).join(', ') + ' …' : ids.join(', ')) + ' |');
  });
  L.push('');

  return L.join('\n');
}

/**
 * 「约定差」小节：把「语料取过去日期 / 我方按未来顺延」这类**约定差异**从真 bug 里摘出来，
 * 让读者能区分「我们的解析错了」和「两边对同一句话的默认日期约定不同」。
 */
function conventionSection(r) {
  const b = r.buckets;
  /* 只收「双方都有值但不同」的约定差；实得 null 属真缺口，不在此列 */
  const conv = r.rows.filter(function (x) {
    if (x.cls === 'OUT_OF_SCOPE' || x.cls === 'PASS' || !x.pastConvention) return false;
    return (x.missedFields || []).some(function (d) { return /实得 "/.test(d); });
  });
  const L = [];
  L.push('## 七、约定差（不是 bug，但会让分数变低）');
  L.push('');
  L.push('检索语料把「2号」「初一」这类**无日锚点的相对日期**标注成**基准日之前**的那一天（它的场景是"查历史记录"）；');
  L.push('闹钟语义必须落在**未来**，所以我们的实现会顺延到下一个周期。这类样本在 gold 里用 `meta.past_convention` 标记，');
  L.push('计数上照算（不剔除），但在这里单列，便于区分「解析错」与「约定不同」。');
  L.push('');
  if (!conv.length) {
    L.push('_无_（本口径下所有可评样本都不涉及过去日期约定）_');
  } else {
    L.push('共 ' + conv.length + ' 条（已计入上面的 DIFF/MISSED，不额外剔除）：');
    L.push('');
    L.push('| 行号 | query | 期望 | 我方 | 差异 |');
    L.push('| --- | --- | --- | --- | --- |');
    conv.forEach(function (x) {
      L.push('| ' + x.idx + ' | ' + mdEscape(x.query) + ' | ' + mdEscape(x.expected) + ' | ' + mdEscape(x.ours) + ' | ' + mdEscape(x.reason) + ' |');
    });
  }
  L.push('');
  const clean = r.stats.gold - conv.length;
  const cleanPass = b.PASS.length;
  L.push('剔除这 ' + conv.length + ' 条约定差后的参考值（**仅供参考，不作为对外口径**）：'
    + cleanPass + '/' + clean + ' = ' + pct(cleanPass, clean) + '。');
  L.push('');
  L.push('### 7.1 语料标注存疑（1 条，已计入 DIFF）');
  L.push('');
  L.push('第 69 行 `清明` 语料标注 `2025-04-05`，实现算出 `2025-04-04`。2025 年清明节气落在 **4 月 4 日**，');
  L.push('故本条更像语料标注偏差而非实现错误；但**没有独立权威数据源在手，不做单方面裁定**，仍按语料原值判 DIFF。');
  L.push('');
  return L.join('\n');
}

/**
 * 一句话结论（按数据自动选口径，不写死）。
 * @param {{stats:Object, buckets:Object, catStats:Object, assertion:Object}} r
 * @return {string}
 */
function conclusion(r) {
  const s = r.stats;
  const b = r.buckets;
  const worst = CATS.concat(EXTRA_CATS)
    .filter(function (c) { return r.catStats[c].n > 0; })
    .sort(function (x, y) { return r.catStats[x].pass / r.catStats[x].n - r.catStats[y].pass / r.catStats[y].n; });
  const best = worst.slice().reverse();
  return '严格可评 ' + s.gold + ' / ' + s.total + ' 条，一致 ' + b.PASS.length + ' 条（'
    + pct(b.PASS.length, s.gold) + '）；'
    + 'MISSED ' + b.MISSED.length + ' 条（该给没给）、SUSPECT ' + b.SUSPECT.length + ' 条（不该给却给了）、DIFF '
    + b.DIFF.length + ' 条（给了但不对）、NOT_COMPARABLE ' + b.NOT_COMPARABLE.length + ' 条；'
    + '不可评 ' + b.OUT_OF_SCOPE.length + ' 条全部在 docs/unsupported.md 有据可查（断言' + (r.assertion.ok ? '通过' : '失败') + '）。'
    + '表现最弱的两类：'
    + worst.slice(0, 2).map(function (c) {
      return c + ' ' + pct(r.catStats[c].pass, r.catStats[c].n) + '（n=' + r.catStats[c].n + '）';
    }).join('、')
    + '；最强：' + best.slice(0, 2).map(function (c) {
      return c + ' ' + pct(r.catStats[c].pass, r.catStats[c].n) + '（n=' + r.catStats[c].n + '）';
    }).join('、') + '。';
}

/* ---------------- 入口 ---------------- */

function main() {
  const result = evaluate();
  const md = renderReport(result)
    + '\n' + conventionSection(result)
    + '\n## 八、结论\n\n' + conclusion(result) + '\n';
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md, 'utf8');

  const s = result.stats;
  const b = result.buckets;
  console.log('\n== fst-time-nlu 语料评测（严格金标准）==');
  console.log('分母：严格可评 ' + s.gold + ' / 语料 ' + s.total + ' 条（' + pct(s.gold, s.total) + '）');
  console.log('参数：opts.now = Date.parse(metadata)，opts.tz = ' + TZ);
  console.log('');
  CAT_ORDER.forEach(function (c) {
    console.log('  ' + (c + '                    ').slice(0, 20) + String(b[c].length).padStart(4) + '   ' + CAT_DESC[c]);
  });
  console.log('');
  console.log('-- 分类 precision / recall --');
  console.log('  ' + '类别'.padEnd(12) + 'n'.padStart(5) + '正确'.padStart(6) + '错误'.padStart(6) + '召回'.padStart(9) + '精度'.padStart(9));
  CATS.concat(EXTRA_CATS).forEach(function (c) {
    const t = result.catStats[c];
    const precDen = t.pass + t.diff + t.suspect;
    console.log('  ' + c.padEnd(12) + String(t.n).padStart(5) + String(t.pass).padStart(6)
      + String(t.n - t.pass).padStart(6) + pct(t.pass, t.n).padStart(9)
      + (precDen ? pct(t.pass, precDen) : '—').padStart(9));
  });
  console.log('');
  console.log('OUT_OF_SCOPE 反查 docs/unsupported.md：' + s.outOfScope + ' 条 / ' + s.outOfScope + ' 行 — '
    + (result.assertion.ok ? '通过' : '失败'));
  if (!result.assertion.ok) result.assertion.problems.forEach(function (p) { console.log('  ❌ ' + p); });

  ['MISSED', 'SUSPECT', 'DIFF'].forEach(function (c) {
    const list = b[c];
    if (!list.length) return;
    console.log('');
    console.log('-- ' + c + '（' + list.length + ' 条）--');
    list.slice(0, TOP_N).forEach(function (x) {
      console.log('  #' + String(x.idx).padStart(3) + ' ' + x.query);
      console.log('        期望: ' + x.expected + '   我方: ' + x.ours + '   ' + x.reason);
    });
    if (list.length > TOP_N) console.log('  … 其余 ' + (list.length - TOP_N) + ' 条见报告');
  });

  console.log('');
  console.log('结论：' + conclusion(result));
  console.log('报告已写入：' + OUT_MD + '\n');
}

if (require.main === module) main();

module.exports = { evaluate, renderReport, conclusion, ourFields, compareStrict, loadCorpus, loadGold, loadUnsupported };
