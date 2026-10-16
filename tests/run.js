/* ============================================================
 * tests/run.js — 回归测试运行器
 *   node tests/run.js
 * 退出码：全部通过=0，有失败=1
 * ============================================================ */
const { parseAlarm } = require('../nlu.js');
const cases = require('./cases.js');

const TIME_RE = /^\d{2}:\d{2}$/;
let pass = 0, fail = 0;
const failures = [];

function check(c) {
  const r = parseAlarm(c.input, c.context ? { context: c.context } : undefined);
  const e = c.expect;
  const errs = [];

  if (e.success !== undefined && r.success !== e.success)
    errs.push(`success 期望 ${e.success} 实得 ${r.success}`);

  // 对话式意图：intent / match / update 断言
  if (e.intent !== undefined && r.intent !== e.intent)
    errs.push(`intent 期望 ${e.intent} 实得 ${r.intent}`);
  if (e.matchTime !== undefined) {
    if (!r.match || r.match.time !== e.matchTime)
      errs.push(`match.time 期望 "${e.matchTime}" 实得 ${r.match ? r.match.time : 'null'}`);
  }
  if (e.matchAll !== undefined) {
    if (!r.match || !r.match.all) errs.push('match.all 应为 true');
  }
  if (e.hasDate !== undefined) {
    if (!r.match || !r.match.date) errs.push('match.date 应存在');
  }
  if (e.matchRecurrence !== undefined) {
    if (!r.match || r.match.recurrence !== e.matchRecurrence)
      errs.push(`match.recurrence 期望 "${e.matchRecurrence}" 实得 ${r.match ? r.match.recurrence : 'null'}`);
  }
  if (e.matchLabel !== undefined) {
    if (!r.match || !(r.match.label || '').includes(e.matchLabel))
      errs.push(`match.label 应包含 "${e.matchLabel}"（实得 ${r.match ? r.match.label : 'null'}）`);
  }
  if (e.updateTime !== undefined) {
    if (!r.update || r.update.time !== e.updateTime)
      errs.push(`update.time 期望 "${e.updateTime}" 实得 ${r.update ? r.update.time : 'null'}`);
  }
  if (e.updateRecurrence !== undefined) {
    if (!r.update || r.update.recurrence !== e.updateRecurrence)
      errs.push(`update.recurrence 期望 "${e.updateRecurrence}" 实得 ${r.update ? r.update.recurrence : 'null'}`);
  }

  if (e.needsClarification !== undefined && r.needs_clarification !== e.needsClarification)
    errs.push(`needs_clarification 期望 ${e.needsClarification} 实得 ${r.needs_clarification}`);

  if (e.clarifyType !== undefined) {
    if (!r.clarification || r.clarification.type !== e.clarifyType)
      errs.push(`clarification.type 期望 ${e.clarifyType} 实得 ${r.clarification ? r.clarification.type : 'null'}`);
  }
  if (e.hasSuggestions) {
    if (!r.clarification || !Array.isArray(r.clarification.suggestions) || r.clarification.suggestions.length === 0)
      errs.push(`clarification.suggestions 应为非空`);
  }

  // 多轮澄清：partial 锚点保留断言
  if (e.partialWeekTarget !== undefined) {
    if (!r.partial || r.partial.weekTarget !== e.partialWeekTarget)
      errs.push(`partial.weekTarget 期望 ${e.partialWeekTarget} 实得 ${r.partial ? r.partial.weekTarget : 'null'}`);
  }
  if (e.partialAbsDateMD !== undefined) {
    const [em, ed] = e.partialAbsDateMD;
    if (!r.partial || !r.partial.absDate || r.partial.absDate.month !== em || r.partial.absDate.day !== ed)
      errs.push(`partial.absDate 期望 ${em}/${ed} 实得 ${r.partial && r.partial.absDate ? r.partial.absDate.month + '/' + r.partial.absDate.day : 'null'}`);
  }

  if (r.success) {
    const a = r.alarm;
    if (e.time !== undefined && a.time !== e.time)
      errs.push(`time 期望 "${e.time}" 实得 "${a.time}"`);
    if (e.recurrence !== undefined && a.recurrence !== e.recurrence)
      errs.push(`recurrence 期望 "${e.recurrence}" 实得 "${a.recurrence}"`);
    if (e.time !== undefined && !TIME_RE.test(a.time))
      errs.push(`time 格式非法 "${a.time}"`);
    if (e.labelIncludes) {
      e.labelIncludes.forEach(w => {
        if (!(a.label || '').includes(w)) errs.push(`label "${a.label}" 应包含 "${w}"`);
      });
    }
    if (e.labelExcludes) {
      e.labelExcludes.forEach(w => {
        if ((a.label || '').includes(w)) errs.push(`label "${a.label}" 不应包含 "${w}"`);
      });
    }
    if (e.relSeconds !== undefined) {
      const nowSec = Math.floor(Date.now() / 1000);
      const diff = a.timestamp - nowSec;
      if (Math.abs(diff - e.relSeconds) > 5)
        errs.push(`相对时间偏移 期望≈${e.relSeconds}s 实得 ${diff}s`);
    }
    if (e.dateFixed !== undefined && a.date !== e.dateFixed)
      errs.push(`date 期望 "${e.dateFixed}" 实得 "${a.date}"`);
    if (e.future && a.timestamp <= Math.floor(Date.now() / 1000))
      errs.push(`date 应晚于当前时间（实得 ${a.date} ${a.time}）`);
    if (e.dow !== undefined) {
      const wd = new Date(a.timestamp * 1000).getDay();
      if (wd !== e.dow) errs.push(`星期 期望 ${e.dow}(0=日..6=六) 实得 ${wd}（${a.date}）`);
    }
    if (e.lead !== undefined && a.lead_minutes !== e.lead)
      errs.push(`lead_minutes 期望 ${e.lead} 实得 ${a.lead_minutes}`);
    if (e.nextOccurrenceMD) {
      const [em, ed] = e.nextOccurrenceMD;
      const t = new Date();
      let y = t.getFullYear();
      let cand = new Date(y, em - 1, ed);
      if (cand < new Date(y, t.getMonth(), t.getDate())) { y += 1; cand = new Date(y, em - 1, ed); }
      const got = new Date(a.timestamp * 1000);
      if (got.getFullYear() !== cand.getFullYear() || got.getMonth() + 1 !== em || got.getDate() !== ed)
        errs.push(`日期 期望最近 ${em}/${ed}（实得 ${a.date}）`);
    }
    if (e.nextWeek) {
      const monOf = dt => { const x = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x.getTime(); };
      const resMon = monOf(new Date(a.timestamp * 1000));
      const todayMon = monOf(new Date());
      if (resMon <= todayMon) errs.push(`date 应属于"下一周"（实得 ${a.date}，本周一=${new Date(todayMon).toISOString().slice(0, 10)}）`);
    }
  }

  if (errs.length) {
    fail++;
    failures.push({ input: c.input, errs });
    console.log(`  ✗ [${c.input}]`);
    errs.forEach(x => console.log(`      - ${x}`));
  } else {
    pass++;
    console.log(`  ✓ ${c.input}`);
  }
}

console.log(`\n== 闹钟 Agent 解析回归测试（${cases.length} 例）==`);
cases.forEach(check);
console.log(`\n结果：通过 ${pass} / ${cases.length}，失败 ${fail}\n`);

if (fail > 0) {
  console.log('失败用例：');
  failures.forEach(f => { console.log(`  · ${f.input}`); f.errs.forEach(x => console.log(`      - ${x}`)); });
  process.exit(1);
} else {
  console.log('全部通过 ✓');
  process.exit(0);
}
