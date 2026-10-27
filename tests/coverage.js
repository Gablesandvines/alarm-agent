/* ============================================================
 * tests/coverage.js —— nlu.js 的行覆盖率 + 正则性能（ReDoS）体检
 *
 * 两部分：
 *   A. 行覆盖率：用 Node 自带的 NODE_V8_COVERAGE（不引第三方）跑 tests/run.js，
 *      解析 v8 的 JSON（byte/char offset → 行号）算 nlu.js 的行覆盖率。
 *   B. ReDoS / 最坏耗时：对已知的「正则高危形态」各造 10k 字输入，
 *      逐条计时并断言 < 50ms；另测 200 字（server.js 的既有输入上限）的 p99。
 *
 * 运行：node tests/coverage.js
 *       node tests/coverage.js --no-cov     （只跑性能部分）
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fileURLToPath } = require('url');
const { parseAlarm } = require('../nlu.js');

const ROOT = path.join(__dirname, '..');
const NLU = path.join(ROOT, 'nlu.js');
// coverage 输出写到系统临时目录：不污染仓库、也不触发「批量删除」保护
// （cc 的 safe-delete 会拦截项目内 ≥50 文件的递归删除）
const COV_DIR = path.join(require('os').tmpdir(), 'alarm_nlu_cov_' + process.pid);
const NOW = Date.parse('2026-10-22T01:43:00Z');

/** v8 coverage 里的 url 是 file:///D:/... 形式，要转成本地路径再比对。 */
function normalizePath(u) {
  if (!u) return '';
  let p = u;
  if (u.startsWith('file://')) {
    try { p = fileURLToPath(u); } catch (_) { p = u.slice(7); }
  }
  p = path.resolve(p);
  // Windows 下大小写不敏感（D:\ vs d:\）
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
const NLU_KEY = normalizePath(NLU);

// ============================================================
// A. 行覆盖率
// ============================================================

/**
 * 解析 v8 coverage JSON，算某个文件的行覆盖率。
 * v8 给的是**字符偏移量**区间与执行次数，不含行号，所以自己建 offset→line 的映射。
 *
 * 判定规则（照实说明，避免「刷覆盖」）：
 *   v8 的区间是**嵌套**的：外层函数区间 count>0，内层没跑的 if/else、try/catch 子块
 *   count=0。所以「某一行算不算跑到」= 取该行**第一个非空白字符**所在的最内层区间，
 *   看它的 count。这正是 v8-to-istanbul 等工具的标准做法。
 *   （早期版本的写法是「count>0 的区间先整行标覆盖，再用 count=0 的区间整行抹掉」，
 *    在单行内既有已执行又有死代码时会把整行误判成未覆盖——例如
 *    `try { s = require(...) } catch (e) { s = null; }` 这行会因 catch 分支没走而
 *    整行算未覆盖。现在按最内层区间判定，既不虚高也不虚低。）
 *   - 空行、纯注释行不计入分母（它们本来就无法「执行」）
 * @param {string} filePath 目标 JS 文件绝对路径
 * @param {Array<Object>} entries v8 coverage 的 result 数组
 * @return {{covered:number[], uncovered:number[], total:number, pct:number}|null}
 */
function lineCoverageOf(filePath, entries) {
  const src = fs.readFileSync(filePath, 'utf8');
  // offset → 行号用的行首偏移表（诊断未覆盖行时按行号回查）
  const lineStart = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStart.push(i + 1);
  // 每行第一个非空白字符的绝对偏移（用于取「最内层区间」）
  const lineSample = [];
  for (let ln = 1; ln <= lineStart.length; ln++) {
    const s = lineStart[ln - 1];
    const e = (ln < lineStart.length) ? lineStart[ln] : src.length;
    let p = s;
    while (p < e && (src.charCodeAt(p) === 32 || src.charCodeAt(p) === 9)) p++;
    lineSample[ln] = (p < e) ? p : s;
  }
  // 只看「可执行行」：非空且不是纯注释
  const lines = src.split('\n');
  const executable = [];
  let inBlockComment = false;
  lines.forEach(function (text, i) {
    let t = text;
    if (inBlockComment) {
      const end = t.indexOf('*/');
      if (end < 0) { executable.push(false); return; }
      t = t.slice(end + 2);
      inBlockComment = false;
    }
    const startBlock = t.indexOf('/*');
    if (startBlock >= 0 && t.indexOf('*/', startBlock + 2) < 0) { inBlockComment = true; t = t.slice(0, startBlock); }
    t = t.trim();
    executable.push(!(t === '' || t.startsWith('//')));
  });

  const matching = entries.filter(function (e) { return normalizePath(e.url) === NLU_KEY; });
  if (!matching.length) return null;

  // 多进程采样**必须按进程分别判定再取并集**：每个进程都会输出整份文件的函数清单，
  // 没跑到的函数 count 恒为 0；若把各进程区间混在一起，冷启动进程会把别的进程
  // 真跑过的行抹成未覆盖（实测会把 88% 打成 55%）。
  const coveredSet = new Set();
  matching.forEach(function (entry) {
    const ranges = [];
    (entry.functions || []).forEach(function (fn) {
      (fn.ranges || []).forEach(function (r) {
        if (r.endOffset > r.startOffset) ranges.push(r);
      });
    });
    if (!ranges.length) return;
    /** 取 offset 所在的最内层（跨度最小）区间的执行次数。 */
    function countAt(offset) {
      let best = null;
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        if (r.startOffset <= offset && offset < r.endOffset) {
          if (!best || (r.endOffset - r.startOffset) < (best.endOffset - best.startOffset)) best = r;
        }
      }
      return best ? best.count : 0;
    }
    for (let ln = 1; ln <= lines.length; ln++) {
      if (!executable[ln - 1]) continue;
      if (countAt(lineSample[ln]) > 0) coveredSet.add(ln);
    }
  });

  const covered = [], uncovered = [];
  for (let ln = 1; ln <= lines.length; ln++) {
    if (!executable[ln - 1]) continue;
    if (coveredSet.has(ln)) covered.push(ln);
    else uncovered.push(ln);
  }
  const total = covered.length + uncovered.length;
  return { covered: covered, uncovered: uncovered, total: total, pct: total ? (covered.length * 100 / total) : 0 };
}

/**
 * 采样脚本清单：故意用**多路真实输入**打覆盖率，而不是往 cases.js 里塞只为
 * 凑数字的用例（cases.js 是与 QA 共用的资产，不归本套件改动）。
 *   run.js        —— 292 条既有回归用例
 *   invariants.js —— 12 条不变量 × 上百条语料的组合输入
 *   fuzz.js       —— 固定种子 42 的 2600+ 条结构化/混沌/畸形输入
 * 三者都是真实断言驱动的输入，命中即为真实可执行路径。
 */
const SAMPLE_SCRIPTS = ['run.js', 'invariants.js', 'fuzz.js'];

function runLineCoverage() {
  cleanup();
  console.log('\n== A. nlu.js 行覆盖率（NODE_V8_COVERAGE，Node 内置）==');
  console.log('采样脚本：' + SAMPLE_SCRIPTS.map(function (s) { return 'tests/' + s; }).join(' + '));
  console.log('          （' + require('./cases.js').length + ' 条用例 + 不变量套件 + SEED=42 模糊测试）');
  for (let i = 0; i < SAMPLE_SCRIPTS.length; i++) {
    try {
      execFileSync(process.execPath, [path.join(__dirname, SAMPLE_SCRIPTS[i])], {
        cwd: ROOT,
        env: Object.assign({}, process.env, { NODE_V8_COVERAGE: COV_DIR, SEED: '42' }),
        stdio: 'ignore'
      });
    } catch (e) {
      console.log('  ✗ 采样失败（' + SAMPLE_SCRIPTS[i] + '）：' + e.message);
      cleanup();
      return 1;
    }
  }
  const files = fs.existsSync(COV_DIR)
    ? fs.readdirSync(COV_DIR).filter(function (f) { return f.endsWith('.json'); })
    : [];
  if (!files.length) { console.log('  ✗ 没找到 v8 coverage 输出'); cleanup(); return 1; }

  let entries = [];
  files.forEach(function (f) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(COV_DIR, f), 'utf8'));
      if (j && Array.isArray(j.result)) entries = entries.concat(j.result);
    } catch (_) { /* 坏文件跳过 */ }
  });

  const cov = lineCoverageOf(NLU, entries);
  if (!cov) { console.log('  ✗ coverage 里没有 nlu.js 的记录'); cleanup(); return 1; }

  console.log('');
  console.log('  可执行行：' + cov.total);
  console.log('  已覆盖：  ' + cov.covered.length);
  console.log('  行覆盖率：' + cov.pct.toFixed(2) + '%   （目标 ≥90%）');
  if (cov.uncovered.length) {
    console.log('  未覆盖行号（' + cov.uncovered.length + ' 行）：');
    console.log('    ' + groupRanges(cov.uncovered));
  }
  cleanup();
  return cov.pct >= 90 ? 0 : 2;
}

/** 把行号数组压成 "12-18, 25, 40-42" 便于阅读。 */
function groupRanges(nums) {
  const out = [];
  let a = null, b = null;
  nums.forEach(function (n) {
    if (a === null) { a = b = n; return; }
    if (n === b + 1) { b = n; return; }
    out.push(a === b ? String(a) : a + '-' + b);
    a = b = n;
  });
  if (a !== null) out.push(a === b ? String(a) : a + '-' + b);
  return out.join(', ');
}

function cleanup() {
  // 清理失败绝不能把整个脚本带崩（安全删除插件可能拦截批量删除）
  try {
    if (!fs.existsSync(COV_DIR)) return;
    fs.readdirSync(COV_DIR).forEach(function (f) {
      try { fs.unlinkSync(path.join(COV_DIR, f)); } catch (_) { /* 单个文件删不掉就跳过 */ }
    });
    try { fs.rmdirSync(COV_DIR); } catch (_) { /* 目录非空就留着 */ }
  } catch (_) { /* 忽略 */ }
}

// ============================================================
// B. ReDoS / 最坏耗时
// ============================================================

/** 已知「正则高危形态」：每一项都是历史上真实出现过的回溯热点。 */
const REDOS_CASES = [
  { name: '点 × 10000',             text: '点'.repeat(10000) },
  { name: '差 × 10000',             text: '差'.repeat(10000) },
  { name: '分 × 10000',             text: '分'.repeat(10000) },
  { name: '点分 × 5000',            text: '点分'.repeat(5000) },
  { name: '中文数字 × 10000',        text: '十'.repeat(10000) },
  { name: '两 × 10000',             text: '两'.repeat(10000) },
  { name: '半小时 × 2000',           text: '半小时'.repeat(2000) },
  { name: '一小时 × 2500',           text: '一小时'.repeat(2500) },
  { name: '5分钟 × 2000',            text: '5分钟'.repeat(2000) },
  { name: '倒计时+中文数字 × 10000',   text: '倒计时' + '一'.repeat(9996) },
  { name: '再过+中文数字 × 10000',     text: '再过' + '十'.repeat(9998) },
  { name: '每+中文数字 × 10000',       text: '每' + '一'.repeat(9999) },
  { name: '号+中文数字 × 10000',       text: '号' + '一'.repeat(9999) },
  { name: 'N天后 堆叠 × 3000',        text: '一'.repeat(3000) + '天' },
  { name: '数字点 混排 × 10000',       text: ('12345点').repeat(1428).slice(0, 10000) },
  { name: '纯数字 × 10000',           text: '1'.repeat(10000) },
  { name: '年份堆叠 × 2500',          text: '2025年'.repeat(1428).slice(0, 10000) },
  { name: '身份证号 × 800',           text: '45901199001011234'.repeat(555).slice(0, 10000) },
  { name: '冒号 × 5000',             text: '12:34'.repeat(2000) },
  { name: '点后接数字 × 10000',        text: ('点1').repeat(3333).slice(0, 10000) }
];

const BUDGET_MS = 50;
const SERVER_LIMIT = 200;   // server.js 既有输入上限

function timeOnce(text) {
  const t0 = process.hrtime.bigint();
  try { parseAlarm(text, { now: NOW, tz: 'Asia/Shanghai' }); } catch (e) { /* 不抛才算过，单独判定 */ }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

function runPerf() {
  console.log('\n== B. ReDoS / 最坏耗时（预算 < ' + BUDGET_MS + 'ms / 条）==');
  let bad = 0;

  // 预热（JIT），让数字反映稳态而不是首跑编译开销
  for (let i = 0; i < 5; i++) timeOnce('明天早上8点提醒我');
  timeOnce('点'.repeat(10000));

  console.log('  10k 字最坏形态：');
  const rows = [];
  REDOS_CASES.forEach(function (c) {
    const text = c.text.slice(0, 10000);
    let threw = null;
    const t0 = process.hrtime.bigint();
    try { parseAlarm(text, { now: NOW, tz: 'Asia/Shanghai' }); } catch (e) { threw = e; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rows.push({ name: c.name, len: text.length, ms: ms });
    const flag = (threw || ms >= BUDGET_MS) ? '✗' : '✓';
    if (threw || ms >= BUDGET_MS) bad++;
    console.log('    ' + flag + ' ' + c.name.padEnd(26, ' ') + String(text.length).padStart(6, ' ') + ' 字  '
      + ms.toFixed(2).padStart(8, ' ') + 'ms' + (threw ? '  抛 ' + threw.name : ''));
  });
  const worst = rows.reduce(function (a, b) { return b.ms > a.ms ? b : a; }, rows[0]);
  console.log('    最慢：' + worst.name + ' ' + worst.ms.toFixed(2) + 'ms');

  // 200 字（真实上限）的 p99：用例语料循环 20 遍，取第 99 百分位
  console.log('  200 字（server.js 上限）p99：');
  const cases = require('./cases.js');
  const samples = [];
  for (let round = 0; round < 20; round++) {
    cases.forEach(function (c) {
      const text = String(c.input).slice(0, SERVER_LIMIT);
      const t0 = process.hrtime.bigint();
      try { parseAlarm(text, { now: NOW, tz: 'Asia/Shanghai' }); } catch (_) { /* 忽略 */ }
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    });
  }
  samples.sort(function (a, b) { return a - b; });
  const pct = function (p) { return samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]; };
  console.log('    样本数 ' + samples.length
    + '  p50 ' + pct(0.50).toFixed(3) + 'ms'
    + '  p95 ' + pct(0.95).toFixed(3) + 'ms'
    + '  p99 ' + pct(0.99).toFixed(3) + 'ms'
    + '  max ' + samples[samples.length - 1].toFixed(3) + 'ms');
  if (pct(0.99) >= BUDGET_MS) { bad++; console.log('    ✗ p99 超出预算'); }

  console.log('');
  console.log('  结论：' + (bad === 0
    ? '未发现回溯爆炸，全部在预算内'
    : bad + ' 项超预算（见上方 ✗）'));
  return bad === 0 ? 0 : 1;
}

// ============================================================
// 主流程
// ============================================================
function main() {
  const skipCov = process.argv.indexOf('--no-cov') >= 0;
  const perfCode = runPerf();
  const covCode = skipCov ? 0 : runLineCoverage();
  console.log('');
  if (skipCov) {
    console.log('结果： ' + (perfCode === 0 ? '性能通过' : '性能未通过'));
  } else {
    console.log('结果： ' + (perfCode === 0 ? '性能通过' : '性能未通过')
      + ' / ' + (covCode === 0 ? '覆盖率达标' : '覆盖率未达标'));
  }
  process.exit(Math.max(perfCode === 0 ? 0 : 1, covCode === 0 ? 0 : 1));
}

main();
