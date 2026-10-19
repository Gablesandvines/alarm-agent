/* ============================================================
 * tests/nlu_eval.js — fst-time-nlu 语料评测（badcase 挖掘，非 npm test 门禁）
 *
 * 用法：node tests/nlu_eval.js
 *   产出：docs/nlu_eval_report.md + 终端摘要
 *
 * 为什么不做「准确率 %」：
 *   语料 tests/fixtures/fst_time_nlu_zh.jsonl 来自 OPPO fst-time-nlu（Apache-2.0），
 *   其 datetime_result 是 **UTC 语义**（基准时间 metadata 也是 UTC）；
 *   而本产品的闹钟一律落在用户时区（缺省 Asia/Shanghai，UTC+08）。
 *   直接算准确率会被 8 小时基准差系统性污染，得出误导性数字。
 *   因此这里只做两件事：
 *     1) 覆盖率统计（我们到底给没给出时刻）；
 *     2) badcase 挖掘（把「该给没给」「给了但可疑」「给了且对得上」分开列出来）。
 *
 * 分类口径（每条样本只归一类，按判定优先级自上而下）：
 *   OUT_OF_SCOPE  区间/整日、多候选(嵌套)、世纪/年代、纯日期无钟点、语料无标注
 *                 —— 与「闹钟时刻解析」任务不同构，跳过严格比较
 *   MISSED        「点/时/分/半/刻」等钟点词在句中出现，但我们没给出时刻 → 真缺口
 *   SUSPECT       我们给出了时刻，但有量词/歧义/误报嫌疑 → 需人工看一眼
 *   PASS          严格比较一致（≤ 60s）
 *   DIFF          严格比较不一致 → 真差异
 *   NOT_COMPARABLE 双方都有时刻，但绝对钟点跨日，无法直接比墙钟
 *
 * 严格比较的口径按句子类型分两条（这是回避「UTC 语料 ↔ +08 产品」基准差的关键）：
 *   相对时长（8分钟后 / 半小时以后）→ 比「距 metadata 走过的分钟数」（elapsed），与墙钟无关
 *   绝对钟点（明天8点 / 中午一点）  → 比「墙钟 HH:MM + 日历日」，与本产品"墙钟不漂移"的契约一致
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseAlarm } = require('../nlu.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'fst_time_nlu_zh.jsonl');
const OUT_MD = path.join(__dirname, '..', 'docs', 'nlu_eval_report.md');
const TZ = 'Asia/Shanghai';
// 容差：≤ 60s（钟点按分钟比较，故等价于 ≤ 1 分钟）
const TOL_MIN = 1;
const TOP_N = 20;

/* ---------------- 语料装载 ---------------- */

/**
 * 读取 JSONL 语料。
 * @return {Array<{query:string, metadata:string, datetime_result:Array}>} 语料行
 */
function loadCorpus() {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const rows = [];
  raw.split(/\r?\n/).forEach(function (line) {
    const s = line.trim();
    if (!s) return;
    try {
      rows.push(JSON.parse(s));
    } catch (e) {
      // 单行损坏不应中断整轮评测，跳过并记录
      rows.push({ query: '', metadata: '', datetime_result: [], __broken: s });
    }
  });
  return rows;
}

/* ---------------- 期望侧归一 ---------------- */

/**
 * 把 datetime_result 归一为可判定的结构。
 *   - groups：保留原始分组（外层=多候选，内层=起止区间）
 *   - isMulti：存在多候选
 *   - isRange：存在起止不同的区间
 *   - pointIso：唯一候选且为单点时的 ISO 串
 *   - hasClock：唯一单点且钟点不为 00:00:00（即语料真的表达了「几点」）
 * @param {Array} dtResult 语料 datetime_result
 * @return {{groups:Array, isMulti:boolean, isRange:boolean, pointIso:?string, hasClock:boolean}}
 */
function normalizeExpected(dtResult) {
  const groups = Array.isArray(dtResult) ? dtResult.filter(Array.isArray) : [];
  let isRange = false;
  groups.forEach(function (g) {
    if (g.length >= 2 && g[0] !== g[g.length - 1]) isRange = true;
  });
  const isMulti = groups.length > 1;
  let pointIso = null;
  if (groups.length === 1 && groups[0].length === 1) pointIso = groups[0][0];
  else if (groups.length === 1 && groups[0].length === 2 && groups[0][0] === groups[0][1]) pointIso = groups[0][0];
  const hasClock = !!pointIso && pointIso.slice(11, 19) !== '00:00:00';
  return { groups: groups, isMulti: isMulti, isRange: isRange, pointIso: pointIso, hasClock: hasClock };
}

/** 把期望侧渲染成一行可读文本，供报告展示。 */
function renderExpected(exp) {
  if (!exp.groups.length) return '（语料无期望）';
  return exp.groups.map(function (g) {
    if (g.length >= 2) return g[0] + ' ~ ' + g[g.length - 1];
    return g[0] || '（空）';
  }).join(' / ');
}

/* ---------------- 判定辅助 ---------------- */

// 句中是否出现「钟点词」——决定 MISSED 是否成立
const CLOCK_WORD_RE = /[点时]|半|刻|分钟|[0-9]{1,2}[:：][0-9]{1,2}/;
// 相对时长表达（「8分钟后」「半小时以后」）：这类句子可比的不是墙钟，而是「距基准过去了多久」
const REL_DURATION_RE = new RegExp(
  '(?:再过|过了|经过)\\s*(?:半|[一二两三四五六七八九十]|\\d+)\\s*(?:秒钟|秒|分钟|分|小时|个?小时|钟头)'
  + '|(?:半|[一二两三四五六七八九十]|\\d+)\\s*(?:秒钟|秒|分钟|分|小时|个?小时|钟头)\\s*(?:后|之后|以后|内|以内)'
);
// 量词/副词「点」的高风险搭配：命中即列为 SUSPECT 人工复核（与 nlu.js 的过滤词典同源，但此处独立实现，
// 以免「测试跟着实现走」把漏网的误报也判成没问题）
const SUSPECT_RE = /(?:快|慢|早|晚|多|少|好|差|有|稍)\s*一?\s*点|一点点|一点(?:都|也|不|没)|(?:[几一二两三四五六七八九十]|\d{1,2})\s*点\s*(?:意见|建议|想法|要求|希望|问题|内容|事项|说明|看法|观点|理由|原因|补充|原则|会|事|东西)/;
// 世纪/年代
const CENTURY_RE = /世纪|年代/;
// 英文词
const LATIN_RE = /[a-zA-Z]{2,}/;

/** HH:MM:SS / HH:MM → 分钟数 */
function toMinutes(hhmmss) {
  const p = String(hhmmss).split(':');
  return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
}

/** 环形距离（同一天内，24h 取模） */
function circularMinDiff(a, b) {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

/* ---------------- 主评测 ---------------- */

/**
 * 逐条评测语料。
 * @return {{rows:Array, stats:Object, buckets:Object}}
 */
function evaluate() {
  const corpus = loadCorpus();
  const rows = [];
  const buckets = {
    OUT_OF_SCOPE: [],
    MISSED: [],
    SUSPECT: [],
    PASS: [],
    DIFF: [],
    NOT_COMPARABLE: []
  };
  const stats = {
    total: 0,
    broken: 0,
    ourTimeFilled: 0,
    ourTimeEmpty: 0,
    ourClarify: 0,
    queryWithClockWord: 0,
    expWithClock: 0,
    relCompared: 0,
    absCompared: 0
  };

  corpus.forEach(function (item, idx) {
    if (item.__broken) { stats.broken++; return; }
    stats.total++;

    const query = item.query || '';
    const baseMs = Date.parse(item.metadata);
    const exp = normalizeExpected(item.datetime_result);

    // 固定基准时间：语料 metadata 作为「现在」，时区固定上海 → 可重复运行
    let res;
    try {
      res = parseAlarm(query, { now: isNaN(baseMs) ? Date.now() : baseMs, tz: TZ });
    } catch (e) {
      res = { success: false, intent: 'create', alarm: null, needs_clarification: true, __error: String(e && e.message || e) };
    }

    const ourTime = res && res.alarm ? res.alarm.time : '';
    const ourDate = res && res.alarm ? res.alarm.date : '';
    const ourIntent = (res && res.intent) || 'create';

    if (ourTime) stats.ourTimeFilled++; else stats.ourTimeEmpty++;
    if (res && res.needs_clarification) stats.ourClarify++;
    const queryHasClock = CLOCK_WORD_RE.test(query);
    if (queryHasClock) stats.queryWithClockWord++;
    if (exp.hasClock) stats.expWithClock++;

    // ---------- 分类 ----------
    let cat, reason;

    if (!exp.groups.length) {
      // 语料无期望：双方都没时间 → 一致；我们却给了时间 → 误报候选
      if (ourTime) { cat = 'SUSPECT'; reason = '语料无期望却给出时刻（误报候选）'; }
      else { cat = 'OUT_OF_SCOPE'; reason = '语料无期望且我方无时刻（无可比对）'; }
    } else if (exp.isMulti) {
      cat = 'OUT_OF_SCOPE'; reason = '多候选（嵌套 ' + exp.groups.length + ' 组）';
    } else if (exp.isRange) {
      cat = 'OUT_OF_SCOPE'; reason = '区间/整日（起止不同，非单点钟点）';
    } else if (CENTURY_RE.test(query)) {
      cat = 'OUT_OF_SCOPE'; reason = '世纪/年代粒度';
    } else if (LATIN_RE.test(query)) {
      cat = 'OUT_OF_SCOPE'; reason = '含英文词';
    } else if (!exp.hasClock) {
      cat = 'OUT_OF_SCOPE'; reason = '纯日期（无钟点）';
    } else if (ourIntent !== 'create') {
      // 取消/修改/查询句本来就不产出闹钟时刻，与「建闹钟」不同构
      cat = 'OUT_OF_SCOPE'; reason = '非新建意图（intent=' + ourIntent + '）';
    } else if (!ourTime) {
      cat = 'MISSED';
      reason = queryHasClock ? '含钟点词但未给出时刻' : '期望有钟点但未给出时刻';
    } else if (SUSPECT_RE.test(query)) {
      cat = 'SUSPECT'; reason = '命中量词/副词「点」高风险搭配';
    } else {
      // 比较口径分两类，避免被「语料 UTC ↔ 产品 +08」的基准差污染：
      //   相对时长（8分钟后）：比「距基准 elapsed」——与墙钟无关
      //   绝对钟点（明天8点）：比「墙钟 HH:MM」——与本产品"墙钟不漂移"的契约一致
      const ourMs = (res.alarm.timestamp || 0) * 1000;
      if (REL_DURATION_RE.test(query)) {
        stats.relCompared++;
        const ourElapsedMin = Math.round((ourMs - baseMs) / 60000);
        const expElapsedMin = Math.round((Date.parse(exp.pointIso) - baseMs) / 60000);
        const d = Math.abs(ourElapsedMin - expElapsedMin);
        if (d <= TOL_MIN) { cat = 'PASS'; reason = '相对时长一致（+ ' + ourElapsedMin + 'min）'; }
        else { cat = 'DIFF'; reason = '相对时长不一致（我方 +' + ourElapsedMin + 'min / 期望 +' + expElapsedMin + 'min）'; }
      } else {
        stats.absCompared++;
        const expDay = String(exp.pointIso).slice(0, 10);
        if (ourDate !== expDay) {
          cat = 'NOT_COMPARABLE'; reason = '跨日（我方 ' + ourDate + ' / 期望 ' + expDay + '）';
        } else {
          const d = circularMinDiff(toMinutes(ourTime), toMinutes(String(exp.pointIso).slice(11, 16)));
          if (d <= TOL_MIN) { cat = 'PASS'; reason = '墙钟一致'; }
          else { cat = 'DIFF'; reason = '墙钟不一致（我方 ' + ourTime + ' / 期望 ' + String(exp.pointIso).slice(11, 16) + '）'; }
        }
      }
    }

    const row = {
      idx: idx + 1, query: query, expected: renderExpected(exp), expIso: exp.pointIso,
      ourTime: ourTime, ourDate: ourDate, ourIntent: ourIntent,
      ourCleared: !!(res && res.needs_clarification), ourError: (res && res.__error) || null,
      cat: cat, reason: reason
    };
    rows.push(row);
    buckets[cat].push(row);
  });

  return { rows: rows, stats: stats, buckets: buckets };
}

/* ---------------- 报告渲染 ---------------- */

const CAT_ORDER = ['MISSED', 'SUSPECT', 'DIFF', 'PASS', 'NOT_COMPARABLE', 'OUT_OF_SCOPE'];
const CAT_DESC = {
  MISSED: '该给时刻却没给（真缺口，优先补）',
  SUSPECT: '给了时刻但可疑（量词/歧义/无期望误报，需人工看）',
  DIFF: '同一日内钟点/时长对不上（真差异）',
  PASS: '钟点或相对时长一致（≤60s）',
  NOT_COMPARABLE: '我方有时刻、期望有钟点但跨日，不能直接比钟点',
  OUT_OF_SCOPE: '不同构样本（区间/多候选/纯日期/世纪/英文/无标注），跳过严格比较'
};

/** 渲染一条样本 */
function renderRow(r) {
  const ours = r.ourTime ? (r.ourDate + ' ' + r.ourTime) : '（空）';
  return '| ' + r.idx + ' | ' + mdEscape(r.query) + ' | ' + mdEscape(r.expected) + ' | ' + ours
    + (r.ourIntent !== 'create' ? ' `' + r.ourIntent + '`' : '') + ' | ' + mdEscape(r.reason) + ' |';
}

function mdEscape(s) {
  return String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * 生成 Markdown 报告。
 * @param {{rows:Array, stats:Object, buckets:Object}} result evaluate() 结果
 * @return {string} Markdown 正文
 */
function renderReport(result) {
  const s = result.stats;
  const b = result.buckets;
  const pct = function (n) { return s.total ? (n * 100 / s.total).toFixed(1) + '%' : '0.0%'; };
  const L = [];

  L.push('# NLU 语料评测报告（fst-time-nlu · 只做覆盖与 badcase 挖掘）');
  L.push('');
  L.push('> 本文件由 `node tests/nlu_eval.js` 自动生成，请勿手工编辑。');
  L.push('> 语料：`tests/fixtures/fst_time_nlu_zh.jsonl`（' + s.total + ' 条，来自 OPPO **fst-time-nlu**，Apache-2.0，见 `tests/fixtures/NOTICE.md`）。');
  L.push('> 解析参数：固定基准时间 `opts.now = Date.parse(metadata)`，`opts.tz = \'Asia/Shanghai\'`，可重复运行。');
  L.push('');
  L.push('## 一、为什么不给「准确率 %」');
  L.push('');
  L.push('语料的 `datetime_result` 是 **UTC 语义**（基准 `metadata` 也是 UTC），本产品的闹钟一律落在用户时区（缺省 `Asia/Shanghai`，UTC+08）。');
  L.push('两边基准相差 8 小时，硬算准确率只会得到一个被系统偏移污染的数字。因此这里只统计：');
  L.push('');
  L.push('1. **覆盖率**——我们到底有没有给出时刻；');
  L.push('2. **badcase 分类**——把「该给没给」「给了但可疑」「给了且对得上」分开列，供人看。');
  L.push('');
  L.push('## 二、总览');
  L.push('');
  L.push('| 指标 | 数值 |');
  L.push('| --- | --- |');
  L.push('| 语料总条数 | ' + s.total + ' |');
  L.push('| 我方给出时刻（覆盖率） | ' + s.ourTimeFilled + '（' + pct(s.ourTimeFilled) + '） |');
  L.push('| 我方未给出时刻 | ' + s.ourTimeEmpty + '（' + pct(s.ourTimeEmpty) + '） |');
  L.push('| 其中触发澄清追问 | ' + s.ourClarify + ' |');
  L.push('| 句中含钟点词（点/时/分/半/刻） | ' + s.queryWithClockWord + ' |');
  L.push('| 语料侧真的表达了钟点 | ' + s.expWithClock + ' |');
  L.push('| 进入严格比较（绝对钟点/墙钟） | ' + s.absCompared + ' |');
  L.push('| 进入严格比较（相对时长/elapsed） | ' + s.relCompared + ' |');
  L.push('| 期望解析失败/损坏行 | ' + s.broken + ' |');
  L.push('');
  L.push('## 三、分类计数');
  L.push('');
  L.push('| 分类 | 条数 | 占比 | 含义 |');
  L.push('| --- | --- | --- | --- |');
  CAT_ORDER.forEach(function (c) {
    L.push('| `' + c + '` | ' + b[c].length + ' | ' + pct(b[c].length) + ' | ' + CAT_DESC[c] + ' |');
  });
  L.push('');
  L.push('## 四、各类 Top ' + TOP_N + '（query / 期望 / 我方结果）');
  L.push('');
  CAT_ORDER.forEach(function (c) {
    const list = b[c];
    L.push('### ' + c + '（' + list.length + ' 条）');
    L.push('');
    if (!list.length) {
      L.push('_无_');
      L.push('');
      return;
    }
    L.push('| # | query | 期望 | 我方 | 说明 |');
    L.push('| --- | --- | --- | --- | --- |');
    list.slice(0, TOP_N).forEach(function (r) { L.push(renderRow(r)); });
    if (list.length > TOP_N) L.push('| … | _其余 ' + (list.length - TOP_N) + ' 条略_ | | | |');
    L.push('');
  });

  return L.join('\n');
}

/**
 * 「已知残留与下一步」小节：把本轮有意不修的部分写清楚，
 * 避免下一个人把已知取舍当成新 bug 重新查一遍。
 * 例句与条数从本次评测结果里取，实现改进后本段会跟着变，不会说假话。
 * @param {{rows:Array, stats:Object, buckets:Object}} result evaluate() 结果
 * @return {string} Markdown 片段
 */
function knownIssuesSection(result) {
  const s = result.stats;
  const b = result.buckets;
  const q = function (list, n) {
    return list.slice(0, n || 5).map(function (r) { return '`' + r.query + '`'; }).join('、');
  };
  const L = [];
  L.push('## 六、已知残留与下一步');
  L.push('');
  L.push('### 6.1 有意保留：裸小数仍会误报（' + b.SUSPECT.length + ' 条）');
  L.push('');
  L.push(b.SUSPECT.length ? b.SUSPECT.map(function (r) {
    return '· `' + r.query + '` → ' + (r.ourDate + ' ' + r.ourTime);
  }).join('\n') : '_无_');
  L.push('');
  L.push('为什么本轮不修：`零点` 本身是合法时刻（「零点准时抢」→ 00:00），仅凭「点后跟单个数字」');
  L.push('无法区分 0.5 与 0:05，硬加规则会误杀真时刻，需要「点后跟量词/单位」这类更强的上下文信号。');
  L.push('带单位或算术语境的写法（`调高24点5度`、`减八点八`、`升高10点五度`、`一点都不好玩`）已全部掩蔽，不会误报。');
  L.push('');
  L.push('### 6.2 待补口径：本轮 DIFF 明细（' + b.DIFF.length + ' 条）');
  L.push('');
  if (!b.DIFF.length) {
    L.push('_无_');
  } else {
    L.push('| query | 期望 | 我方 | 差异 |');
    L.push('| --- | --- | --- | --- |');
    b.DIFF.forEach(function (r) {
      L.push('| ' + mdEscape(r.query) + ' | ' + mdEscape(r.expected) + ' | ' + (r.ourDate + ' ' + r.ourTime) + ' | ' + mdEscape(r.reason) + ' |');
    });
  }
  L.push('');
  L.push('### 6.3 不可比样本（' + b.NOT_COMPARABLE.length + ' 条）');
  L.push('');
  L.push('双方都给出了时刻，但公历日不同（多为「已过期顺延」与语料基准日不一致），无法直接比墙钟，仅供参考。');
  L.push('');
  L.push('### 6.4 语料结构限制');
  L.push('');
  L.push(s.total + ' 条中 ' + b.OUT_OF_SCOPE.length + ' 条为「日期粒度区间 / 多候选 / 纯日期 / 世纪 / 无标注」'
    + '（如「这周」「周五去北京的机票」），与闹钟场景不同构。');
  L.push('可做严格比较的样本仅 ' + (s.absCompared + s.relCompared) + ' 条（绝对钟点 ' + s.absCompared
    + ' + 相对时长 ' + s.relCompared + '），因此本报告只给覆盖与 badcase 清单，不给准确率——任何「准确率」对这张语料都会失真。');
  L.push('');
  L.push('### 6.5 下一步建议');
  L.push('');
  L.push('1. 补「过 / 差」表达（`十点过六分`、`十点差五分`）——改动小、直击口语。');
  L.push('2. 裸小数误报需要更强的上下文信号（后面跟量词/单位），优先级最低。');
  L.push('3. 语料侧若要评价精度，需先把它改造成「闹钟语义」（+08 基准 + 单点钟点），本报告不背这个包袱。');
  L.push('');
  return L.join('\n');
}

/**
 * 一句话结论（按数据自动选口径，不写死）。
 * @param {{stats:Object, buckets:Object}} result
 * @return {string}
 */
function conclusion(result) {
  const s = result.stats;
  const b = result.buckets;
  const comparable = (s.relCompared || 0) + (s.absCompared || 0);
  const good = b.PASS.length;
  if (!comparable) {
    return '语料以「日期粒度 + 区间/多候选」为主，可做严格比较的样本为 0，本轮只产出覆盖与 badcase 清单，不足以评价钟点解析精度。';
  }
  const rate = (good * 100 / comparable).toFixed(0);
  return '在 ' + comparable + ' 条可做严格比较的样本（绝对钟点 ' + s.absCompared + ' 条按墙钟比、相对时长 '
    + s.relCompared + ' 条按 elapsed 比）中，' + good + ' 条一致（' + rate + '%）；'
    + (b.MISSED.length ? ('MISSED ' + b.MISSED.length + ' 条是下一轮补解析口径的优先输入；') : 'MISSED 已清零（该给时刻的句子都给出来了）；')
    + 'SUSPECT ' + b.SUSPECT.length + ' 条需人工复核是否残留误报，DIFF ' + b.DIFF.length + ' 条已定位到具体说法。';
}

/* ---------------- 入口 ---------------- */

function main() {
  const result = evaluate();
  const md = renderReport(result)
    + '\n## 五、结论\n\n' + conclusion(result) + '\n\n'
    + knownIssuesSection(result);
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md, 'utf8');

  const s = result.stats;
  const b = result.buckets;
  console.log('\n== fst-time-nlu 语料评测（覆盖 + badcase 挖掘，非准确率）==');
  console.log('语料：' + FIXTURE);
  console.log('参数：opts.now = Date.parse(metadata)，opts.tz = ' + TZ);
  console.log('');
  console.log('总条数              ' + s.total);
  console.log('我方给出时刻(覆盖)  ' + s.ourTimeFilled + ' / ' + s.total);
  console.log('我方未给出时刻      ' + s.ourTimeEmpty + '（其中触发澄清 ' + s.ourClarify + '）');
  console.log('含钟点词的 query    ' + s.queryWithClockWord);
  console.log('语料侧有钟点        ' + s.expWithClock);
  console.log('严格比较(绝对钟点)  ' + s.absCompared);
  console.log('严格比较(相对时长)  ' + s.relCompared);
  console.log('');
  CAT_ORDER.forEach(function (c) {
    console.log('  ' + (c + '                ').slice(0, 16) + String(b[c].length).padStart(4) + '   ' + CAT_DESC[c]);
  });
  console.log('');

  ['MISSED', 'SUSPECT', 'DIFF'].forEach(function (c) {
    const list = b[c];
    if (!list.length) return;
    console.log('-- ' + c + ' Top ' + Math.min(TOP_N, list.length) + ' --');
    list.slice(0, TOP_N).forEach(function (r) {
      const ours = r.ourTime ? (r.ourDate + ' ' + r.ourTime) : '（空）';
      console.log('  #' + String(r.idx).padStart(3) + ' ' + r.query);
      console.log('        期望: ' + r.expected);
      console.log('        我方: ' + ours + '   ' + r.reason);
    });
    console.log('');
  });

  console.log('结论：' + conclusion(result));
  console.log('报告已写入：' + OUT_MD + '\n');
}

if (require.main === module) main();

module.exports = { evaluate, renderReport, conclusion, normalizeExpected, loadCorpus };
