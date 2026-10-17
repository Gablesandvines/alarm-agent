/* ============================================================
 * nlu.js — 闹钟 Agent 自然语言时间解析引擎（规则 + 词典）
 * 纯前端、零依赖、可离线运行。
 * 暴露全局函数 parseAlarm(text) -> JSON
 * ============================================================ */
(function (global) {
  'use strict';

  // ---- 双端取用 scheduler.js 的时区换算（惰性，免疫 <script> 加载顺序） ----
  // 浏览器：index.html 已挂 window.Scheduler；Node：同目录 require。
  // 所有墙钟↔UTC、偏移、日历日拆分均调用 scheduler，严禁本文件新造时区换算函数。
  var _sched;
  function sched() {
    if (_sched) return _sched;
    var s = null;
    if (typeof window !== 'undefined' && window.Scheduler) {
      s = window.Scheduler;
    } else if (typeof require === 'function') {
      try { s = require('./scheduler.js'); } catch (e) { s = null; }
    }
    // 兜底：scheduler.js 顶层函数声明在浏览器会提升为全局；若 window.Scheduler 缺失则就地组装
    if ((!s || typeof s.tzDateParts !== 'function') && typeof global !== 'undefined' && typeof global.tzDateParts === 'function') {
      s = {
        tzOffsetAt: global.tzOffsetAt, wallToEpoch: global.wallToEpoch, tzDateParts: global.tzDateParts,
        addDays: global.addDays, daysInMonth: global.daysInMonth, weekdayOf: global.weekdayOf,
        nextTriggerMs: global.nextTriggerMs, computeNext: global.computeNext, wallClockAt: global.wallClockAt,
        isWorkday: global.isWorkday, setHolidays: global.setHolidays, HOLIDAYS: global.HOLIDAYS, endExceeded: global.endExceeded
      };
    }
    _sched = s || null;
    return _sched;
  }

  function cnNum(s) {
    if (s === undefined || s === null) return null;
    s = String(s);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const d = { '零': 0, '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
    if (s === '十') return 10;
    if (s.includes('十')) {
      const [a, b] = s.split('十');
      const tens = a ? (d[a] || 0) * 10 : 10;
      const ones = b ? (d[b] || 0) : 0;
      return tens + ones;
    }
    return (d[s] !== undefined) ? d[s] : null;
  }

  const WEEK = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, '七': 0 };
  // 星期字符 → 数字（0=周日..6=周六），同时支持数字写法（0/7=周日，1..6）
  function weekNum(c) {
    if (WEEK[c] !== undefined) return WEEK[c];
    const d = parseInt(c, 10);
    if (!isNaN(d)) return (d === 0 || d === 7) ? 0 : d;
    return null;
  }

  // 绝对日历日期解析：支持 2026年10月10日 / 2026-10-10 / 10月10日 / 10号 / 8日 等
  // 返回 { year?, month?, day, consumed }，未提供的字段用 undefined 表示（由组合逻辑按上下文补全年/月）
  function parseAbsDate(text) {
    let m;
    // ISO：YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
    if ((m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)))
      return { year: +m[1], month: +m[2], day: +m[3], consumed: m[0] };
    // 中文完整：YYYY年MM月DD日/号（日/号可选）
    if ((m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)))
      return { year: +m[1], month: +m[2], day: +m[3], consumed: m[0] };
    // 中文月-日：MM月DD日/号（日/号必须）
    if ((m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)))
      return { month: +m[1], day: +m[2], consumed: m[0] };
    // 中文日-号：DD日/号
    if ((m = text.match(/(\d{1,2})\s*[日号]/)))
      return { day: +m[1], consumed: m[0] };
    return null;
  }

  // 节假日识别：返回与 absDate 同结构的 { year?, month, day, consumed }
  // 阳历节日为固定月日（year 留空→按"过期顺延"）；农历节日给近年份的精确公历日期（需逐年维护或可接转换库）
  const HOLIDAY_SOLAR = {
    '元旦': [1, 1], '元旦节': [1, 1], '劳动节': [5, 1], '劳动': [5, 1], '五一': [5, 1],
    '国庆': [10, 1], '国庆节': [10, 1], '儿童节': [6, 1], '妇女节': [3, 8], '青年节': [5, 4],
    '教师节': [9, 10], '建军节': [8, 1], '植树节': [3, 12], '清明节': [4, 5], '圣诞': [12, 25], '圣诞节': [12, 25]
  };
  const HOLIDAY_LUNAR = {
    '春节': { '2026': [2, 17], '2027': [2, 6] },
    '元宵': { '2026': [3, 3], '2027': [2, 21] },
    '端午': { '2026': [6, 19], '2027': [6, 9] },
    '七夕': { '2026': [8, 19], '2027': [8, 8] },
    '中秋': { '2026': [9, 25], '2027': [9, 15] }, '中秋节': { '2026': [9, 25], '2027': [9, 15] },
    '重阳': { '2026': [10, 18], '2027': [10, 8] }
  };
  function parseHoliday(text, now) {
    for (const name in HOLIDAY_SOLAR) {
      if (text.includes(name)) return { month: HOLIDAY_SOLAR[name][0], day: HOLIDAY_SOLAR[name][1], consumed: name };
    }
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (const name in HOLIDAY_LUNAR) {
      if (text.includes(name)) {
        const map = HOLIDAY_LUNAR[name];
        const cands = [now.getFullYear(), now.getFullYear() + 1]
          .filter(y => map[String(y)])
          .map(y => ({ y: +y, md: map[String(y)] }));
        cands.sort((a, b) => new Date(a.y, a.md[0] - 1, a.md[1]) - new Date(b.y, b.md[0] - 1, b.md[1]));
        const chosen = cands.find(c => new Date(c.y, c.md[0] - 1, c.md[1]) >= today0) || cands[0];
        if (chosen) return { year: chosen.y, month: chosen.md[0], day: chosen.md[1], consumed: name };
      }
    }
    return null;
  }

  // 多轮澄清：把已理解的日期/星期锚点描述成中文，用于聚焦追问
  function describeDay(o) {
    if (o.absDate) return (o.absDate.month || '?') + '月' + (o.absDate.day || '?') + '日';
    if (o.weekTarget != null) {
      const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return (o.weekNext ? '下' : '本') + names[o.weekTarget];
    }
    if (o.dayOffset) {
      const map = { '1': '明天', '2': '后天', '3': '大后天', '-1': '昨天', '-2': '前天' };
      return map[String(o.dayOffset)] || '那天';
    }
    return '那天';
  }
  // 构造 partial：仅保留已理解、但仍缺具体时刻的锚点，供下一轮结构化合并
  function buildPartial(o) {
    const p = {};
    if (o.recurrence && o.recurrence !== 'none') p.recurrence = o.recurrence;
    if (o.weekTarget != null) { p.weekTarget = o.weekTarget; p.weekNext = !!o.weekNext; }
    else if (o.dayOffset) p.dayOffset = o.dayOffset;
    else if (o.absDate) p.absDate = { year: o.absDate.year, month: o.absDate.month, day: o.absDate.day };
    if (o.leadMin) p.lead_minutes = o.leadMin;
    if (o.label) p.label = o.label;
    return p;
  }

  /* ---------------- 对话式意图：取消 / 修改 / 查询 ----------------
   * 这些助手让 parseAlarm 在不依赖「闹钟列表」的前提下，仅产出结构化指令
   * （match / update）。真正的匹配与执行由持有列表的前端/服务端完成。 */
  const pad2 = n => String(n).padStart(2, '0');
  const DAYOFF = { '今天': 0, '今日': 0, '明天': 1, '明早': 1, '明晨': 1, '明晚': 1, '后天': 2, '大后天': 3, '昨天': -1, '前天': -2 };

  // 从文本中抽取一个时刻（与 create 路径的时刻正则同源，但只取首尾、不构造 target）
  function matchTime(t) {
    let m;
    if ((m = t.match(/(\d{1,2})[:：](\d{1,2})/))) return pad2(+m[1]) + ':' + pad2(+m[2]);
    if ((m = t.match(/(\d{1,2})\s*点\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/))) {
      let h = +m[1], mi = 0;
      if (m[2] === '半') mi = 30; else if (m[2] === '一刻') mi = 15; else if (m[2] === '三刻') mi = 45; else if (m[3] !== undefined) mi = +m[3];
      if (h === 24) h = 0;
      return pad2(h) + ':' + pad2(mi);
    }
    if ((m = t.match(/(十|[零一二两三四五六七八九])\s*点\s*(半|一刻|三刻|([零一二两三四五六七八九])\s*分?)?/))) {
      let h = cnNum(m[1]), mi = 0;
      if (m[2] === '半') mi = 30; else if (m[2] === '一刻') mi = 15; else if (m[2] === '三刻') mi = 45; else if (m[3] !== undefined) mi = cnNum(m[3]);
      if (h === 24) h = 0;
      return pad2(h) + ':' + pad2(mi);
    }
    return null;
  }
  function matchRecurrence(t) {
    let m;
    if ((m = t.match(/(每天|每日|每一天)/))) return 'daily';
    if ((m = t.match(/(工作日|周一到周五|星期一到星期五)/))) return 'weekdays';
    if ((m = t.match(/(周末|周六周日|星期六星期天)/))) return 'weekend';
    if ((m = t.match(/(每周|每星期|每个礼拜)([一二三四五六日天七\d])/))) return 'weekly:' + weekNum(m[2]);
    return null;
  }
  // 取消/修改：从「被操作对象描述」中抽取匹配条件
  function extractMatch(t) {
    const match = {};
    if (/所有|全部|都|每一个|所有闹钟|全部闹钟/.test(t)) match.all = true;
    const tm = matchTime(t); if (tm) match.time = tm;
    const rec = matchRecurrence(t); if (rec) match.recurrence = rec;
    for (const k in DAYOFF) { if (t.includes(k)) { const d = new Date(); d.setDate(d.getDate() + DAYOFF[k]); match.date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; break; } }
    let rest = t.replace(/(取消|删掉|删除|去掉|移除|撤销|关掉|改成|改为|调整为|改到|换为|换成|设成|调成|更新为|把|将|这个|那个|我的|我|的|闹钟|提醒|所有|全部|都|一个|那|这|就|请|帮|一下|吧|了|也)/g, '');
    // 去掉已被 time/recurrence/date 消费掉的文本，避免残留污染 label
    rest = rest.replace(/(\d{1,2})[:：]\d{1,2}/g, '').replace(/(\d{1,2})\s*点\s*(半|一刻|三刻|\d{1,2}\s*分?)?/g, '').replace(/(十|[零一二两三四五六七八九])\s*点\s*(半|一刻|三刻|([零一二两三四五六七八九])\s*分?)?/g, '');
    rest = rest.replace(/(每天|每日|每一天|工作日|周末|每周|每星期|每个礼拜|周[一二三四五六日天七]|星期[一二三四五六日天七]|礼拜[一二三四五六日天七]|周一到周五|星期一到星期五)/g, '');
    for (const k in DAYOFF) rest = rest.split(k).join('');
    rest = rest.replace(/\s+/g, '').trim();
    if (rest) match.label = rest;
    return match;
  }
  // 修改：从「新值描述」中抽取待更新字段
  function extractUpdate(spec) {
    const u = {};
    const tm = matchTime(spec); if (tm) u.time = tm;
    const rec = matchRecurrence(spec); if (rec) u.recurrence = rec;
    let m;
    if ((m = spec.match(/提前\s*(半|一|两|二|三|四|五|六|七|八|九|十|\d+)\s*(分钟|分|个?小时|小时|钟头)/))) {
      const isHalf = m[1] === '半'; const n = isHalf ? 30 : cnNum(m[1]);
      u.lead_minutes = isHalf ? 30 : ((m[2].includes('小时') || m[2].includes('钟头')) ? n * 60 : n);
    }
    let rest = spec.replace(/(改成|改为|调整为|改到|换为|换成|设成|调成|更新为|把|将|这个|那个|我的|我|的|闹钟|提醒|提前|所有|全部|都|一个|那|这|就|请|帮|一下|吧|了|也)/g, '');
    rest = rest.replace(/(\d{1,2})[:：]\d{1,2}/g, '').replace(/(\d{1,2})\s*点\s*(半|一刻|三刻|\d{1,2}\s*分?)?/g, '').replace(/(十|[零一二两三四五六七八九])\s*点\s*(半|一刻|三刻|([零一二两三四五六七八九])\s*分?)?/g, '');
    rest = rest.replace(/(每天|每日|每一天|工作日|周末|每周|每星期|每个礼拜|周[一二三四五六日天七]|星期[一二三四五六日天七]|礼拜[一二三四五六日天七]|周一到周五|星期一到星期五)/g, '');
    for (const k in DAYOFF) rest = rest.split(k).join('');
    rest = rest.replace(/\s+/g, '').trim();
    if (rest) u.label = rest;
    return u;
  }
  function detectIntent(text) {
    let m;
    // 修改：把X改成Y / 改为 / 调整为 / 改到 / 换为 / 换成 / 设成 / 调成 / 更新为（末尾目标可空 → 触发"要改成什么"追问）
    if ((m = text.match(/(?:把|将)?\s*(.{0,16}?)\s*(?:改成|改为|调整为|改到|换为|换成|设成|调成|更新为)\s*(.*)/))) {
      return { intent: 'modify', oldSpec: (m[1] || '').trim(), newSpec: (m[2] || '').trim() };
    }
    // 取消 / 删除类：需含 闹钟/提醒 域词，或含 时间/重复/全部 等闹钟信号，避免劫持普通含"取消"的建闹钟句
    const CANCEL_RE = /(取消|删掉|删除|去掉|移除|撤销|关掉|别再?提醒|不要了)\s*(了|这个|那个|我的|那个)?/;
    const hasDomain = /(闹钟|提醒)/.test(text);
    const hasSignal = hasDomain || !!matchTime(text) || !!matchRecurrence(text) || /所有|全部|都/.test(text);
    if (CANCEL_RE.test(text) && hasSignal) return { intent: 'cancel' };
    // 查询类：必须含 闹钟/提醒 域词
    if (hasDomain && /(有哪些|有什么|列出|查看|显示|看下?|查一下|告诉我|都有|几个|多少|列表|清单|在吗|呢)/.test(text)) return { intent: 'query' };
    if (/^(我的)?\s*(闹钟|提醒)\s*$/.test(text) || /(闹钟|提醒)\s*(列表|清单)/.test(text)) return { intent: 'query' };
    return { intent: 'create' };
  }

  // 重复闹钟「结束条件」解析：到某天为止 / 持续N天 / 共N次（仅对重复闹钟生效；单次闹钟忽略）
  function parseEndDate(s, nowDate) {
    s = (s || '').trim(); if (!s) return null;
    const dim = (y, mo) => new Date(y, mo, 0).getDate();
    const ad = parseAbsDate(s);
    if (ad) {
      let year = ad.year, month = ad.month, day = ad.day;
      const today0 = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
      if (year === undefined) { year = nowDate.getFullYear(); if (new Date(year, month - 1, day) < today0) year++; }
      if (month === undefined) { month = nowDate.getMonth() + 1; if (new Date(year, month - 1, day) < today0) { month++; if (month > 12) { month = 1; year++; } } }
      return `${year}-${pad2(month)}-${pad2(day)}`;
    }
    let m;
    if ((m = s.match(/(今|本|这|明|次)\s*年底/))) { let y = nowDate.getFullYear(); if (m[1] === '明' || m[1] === '次') y += 1; return `${y}-12-31`; }
    if (/月底/.test(s)) { const y = nowDate.getFullYear(), mo = nowDate.getMonth() + 1; return `${y}-${pad2(mo)}-${pad2(dim(y, mo))}`; }
    if ((m = s.match(/(下|本|这)?\s*(周|星期|礼拜)\s*([一二三四五六日天七\d])/))) {
      const w = weekNum(m[3]); const base = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());
      const curMon = (base.getDay() + 6) % 7, tgtMon = (w + 6) % 7;
      let add = tgtMon - curMon;
      if (m[1] !== '下') { const tw = new Date(base); tw.setDate(tw.getDate() + add); if (tw < base) add += 7; } else { add = tgtMon - curMon + 7; }
      const d = new Date(base); d.setDate(d.getDate() + add);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
    for (const k in DAYOFF) { if (s.includes(k)) { const d = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()); d.setDate(d.getDate() + DAYOFF[k]); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; } }
    return null;
  }
  function parseEnd(text, nowDate) {
    let m, raw = null;
    if ((m = text.match(/(?:持续|连续|坚持|连|共)\s*(半|一|两|二|三|四|五|六|七|八|九|十|\d+)\s*天/))) { const n = m[1] === '半' ? 15 : cnNum(m[1]); if (n) return { end: { type: 'days', days: n }, raw: m[0] }; }
    if ((m = text.match(/共\s*(半|一|两|二|三|四|五|六|七|八|九|十|\d+)\s*次/))) { const n = m[1] === '半' ? 5 : cnNum(m[1]); if (n) return { end: { type: 'count', count: n }, raw: m[0] }; }
    if ((m = text.match(/响\s*(半|一|两|二|三|四|五|六|七|八|九|十|\d+)\s*次/))) { const n = m[1] === '半' ? 5 : cnNum(m[1]); if (n) return { end: { type: 'count', count: n }, raw: m[0] }; }
    if ((m = text.match(/(\d+)\s*次\s*(?:后|之后|停止|就停|结束|不再)/))) { const n = cnNum(m[1]); if (n) return { end: { type: 'count', count: n }, raw: m[0] }; }
    if ((m = text.match(/((?:到|直到|直至)\s*[^，。,.\s]*?\s*(?:为止|才停|结束|停止|就不?再?|后才?|就不再|了)?)\s*$/))) {
      const full = m[1]; const clause = full.replace(/^(?:到|直到|直至)\s*/, '').replace(/(?:为止|才停|结束|停止|就不?再?|后才?|就不再|了)?$/, '');
      const d = parseEndDate(clause, nowDate); if (d) return { end: { type: 'date', date: d }, raw: full };
    }
    if ((m = text.match(/((?:到|直到|直至)\s*[^，。,.\s]{1,24}?)(?:为止|才停|结束|停止|就|后)/))) {
      const full = m[1]; const clause = full.replace(/^(?:到|直到|直至)\s*/, '');
      const d = parseEndDate(clause, nowDate); if (d) return { end: { type: 'date', date: d }, raw: full };
    }
    return null;
  }

  function parseAlarm(text, opts) {
    text = (text || '').trim();
    // ---- 0. 对话式意图识别（取消 / 修改 / 查询 / 新建） ----
    const intentRes = detectIntent(text);
    if (intentRes.intent === 'cancel') {
      return { success: true, intent: 'cancel', raw: text, match: extractMatch(text), confidence: 0.9, needs_clarification: false, ambiguities: [] };
    }
    if (intentRes.intent === 'query') {
      return { success: true, intent: 'query', raw: text, confidence: 0.9, needs_clarification: false, ambiguities: [] };
    }
    if (intentRes.intent === 'modify') {
      const match = extractMatch(intentRes.oldSpec || '');
      const update = extractUpdate(intentRes.newSpec || '');
      if (!Object.keys(update).length) {
        return {
          success: false, intent: 'modify', raw: text, needs_clarification: true,
          ambiguities: ['要改成什么？例如：改成9点 / 改成每天'],
          clarification: { type: 'modify_target', question: '要改成什么？例如：改成9点、改成每天、改成7点半', suggestions: ['改成9点', '改成每天', '改成7点半'] },
          match
        };
      }
      return { success: true, intent: 'modify', raw: text, match, update, confidence: 0.9, needs_clarification: false, ambiguities: [] };
    }
    const consumed = [];
    let confidence = 0.5;
    let needsClarification = false;
    const ambiguities = [];

    // ---- 1. 重复规则 ----
    let recurrence = 'none';
    let m;
    if ((m = text.match(/(每天|每日|每一天)/))) { recurrence = 'daily'; consumed.push(m[0]); }
    else if ((m = text.match(/(工作日|周一到周五|星期一到星期五|礼拜一到礼拜五|周一到周五四)/))) { recurrence = 'weekdays'; consumed.push(m[0]); }
    else if ((m = text.match(/(周末|周六周日|星期六星期天|周六日)/))) { recurrence = 'weekend'; consumed.push(m[0]); }
    else if ((m = text.match(/每([零一二两三四五六七八九十百\d]+)天/))) { recurrence = 'every:' + cnNum(m[1]); consumed.push(m[0]); }
    else if ((m = text.match(/(隔|双)(周|星期|礼拜|个)([一二三四五六日天七\d])/))) { recurrence = 'biweekly:' + weekNum(m[3]); consumed.push(m[0]); }
    else if ((m = text.match(/(每周|每星期|每个礼拜)([一二三四五六日天七\d])/))) { recurrence = 'weekly:' + weekNum(m[2]); consumed.push(m[0]); }
    else if ((m = text.match(/(每个月|每月)(\d{1,2}|[一二两三四五六七八九十]+)(号|日)/))) { recurrence = 'monthly:' + cnNum(m[2]); consumed.push(m[0]); }

    // ---- 2. 相对时间（必须带"后/以后"后缀，避免与"提前X分钟"冲突） ----
    let relMatch = null;
    const relRe = /(半|一|两|二|三|四|五|六|七|八|九|十|\d+)\s*(秒钟|秒|分钟|分|小时|个?小时|钟头)\s*(后|之后|以后)/;
    if ((m = text.match(relRe))) {
      const isHalf = m[1] === '半';
      const num = isHalf ? 30 : cnNum(m[1]);
      const unit = isHalf ? '分' : m[2];   // “半小时”=30 分钟，固定为分钟单位
      if (num !== null) { relMatch = { num, unit }; consumed.push(m[0]); }
    }

    // ---- 3. 日锚点（含 今/明/后 + 早/晚/午 复合） ----
    let dayOffset = 0, dayAnchorConsumed = null;
    if ((m = text.match(/(大后天)/))) { dayOffset = 3; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(后天)/))) { dayOffset = 2; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(明天|明早|明晨|明晚|次日)/))) { dayOffset = 1; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(今天|今日|今早|今晨|今午|今晚|现在|此刻)/))) { dayOffset = 0; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(昨天|昨日)/))) { dayOffset = -1; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(前天)/))) { dayOffset = -2; dayAnchorConsumed = m[0]; }
    let compoundTod = 0;
    if (dayAnchorConsumed && /晚/.test(dayAnchorConsumed)) compoundTod = 12;
    if (dayAnchorConsumed) consumed.push(dayAnchorConsumed);

    // ---- 4. 星期锚点（支持汉字与数字，如 下周6 / 周6 / 星期6 / 礼拜6） ----
    let weekTarget = null, weekNext = false;
    if ((m = text.match(/(下个?|下星期|下礼拜|下周)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = true; consumed.push(m[0]); }
    else if ((m = text.match(/(本个?|本星期|本礼拜|本周)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = false; consumed.push(m[0]); }
    else if ((m = text.match(/(周|星期|礼拜)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = false; consumed.push(m[0]); }

    // ---- 5. 时段词（校正小时） ----
    let todAdd = compoundTod, todConsumed = null;
    if (todAdd === 0) {
      if ((m = text.match(/(凌晨|拂晓)/))) { todAdd = 0; todConsumed = m[0]; }
      else if ((m = text.match(/(早上|早晨|上午|清早)/))) { todAdd = 0; todConsumed = m[0]; }
      else if ((m = text.match(/(中午|正午)/))) { todAdd = 0; todConsumed = m[0]; }
      else if ((m = text.match(/(下午|傍晚|黄昏)/))) { todAdd = 12; todConsumed = m[0]; }
      else if ((m = text.match(/(晚上|夜里|夜晚|深夜)/))) { todAdd = 12; todConsumed = m[0]; }
      else if ((m = text.match(/(晚|夜)/))) { todAdd = 12; todConsumed = m[0]; }
      if (todConsumed) consumed.push(todConsumed);
    }

    // ---- 6. 时刻解析 ----
    let hour = null, minute = 0, timeConsumed = null;
    if ((m = text.match(/(\d{1,2})[:：](\d{1,2})/))) { hour = parseInt(m[1], 10); minute = parseInt(m[2], 10); timeConsumed = m[0]; }
    else if ((m = text.match(/(\d{1,2})\s*点\s*(半|一刻|三刻|(\d{1,2})\s*分?)?/))) {
      hour = parseInt(m[1], 10);
      if (m[2] === '半') minute = 30;
      else if (m[2] === '一刻') minute = 15;
      else if (m[2] === '三刻') minute = 45;
      else if (m[3] !== undefined) minute = parseInt(m[3], 10);
      else minute = 0;
      timeConsumed = m[0];
    } else if ((m = text.match(/(十|[零一二两三四五六七八九])\s*点\s*(半|一刻|三刻|([零一二两三四五六七八九])\s*分?)?/))) {
      hour = cnNum(m[1]);
      if (m[2] === '半') minute = 30;
      else if (m[2] === '一刻') minute = 15;
      else if (m[2] === '三刻') minute = 45;
      else if (m[3] !== undefined) minute = cnNum(m[3]);
      else minute = 0;
      timeConsumed = m[0];
    }
    if (timeConsumed) consumed.push(timeConsumed);

    // ---- 2.5 提前提醒（lead） ----
    let leadMin = null, leadConsumed = null;
    if ((m = text.match(/提前\s*(半|一|两|二|三|四|五|六|七|八|九|十|\d+)\s*(分钟|分|个?小时|小时|钟头)/))) {
      const isHalf = m[1] === '半';
      const n = isHalf ? 30 : cnNum(m[1]);
      // “半小时”=30 分钟（已是分钟，不再乘 60）；其余：小时单位才乘 60
      leadMin = isHalf ? 30 : ((m[2].includes('小时') || m[2].includes('钟头')) ? n * 60 : n);
      leadConsumed = m[0]; consumed.push(m[0]);
    }

    // ---- 6.5 绝对日期锚点（含节假日） ----
    // 支持 opts.now 覆盖"当前时间"基准（开放 API 的确定性测试/回放）；默认取真实当前时间
    // tz：贯穿全函数的时区（P3）。默认上海；显式 opts.tz 优先（开放 API / 前端检测传入）。
    const tz = (opts && opts.tz) || 'Asia/Shanghai';
    const now = (opts && opts.now != null) ? new Date(opts.now) : new Date();
    const nowEpoch = now.getTime();
    // 用户在 tz 下的"今天"日历日（跨时区基准，避免 UTC 容器下错位）。所有换算走 scheduler。
    const todayTz = sched().tzDateParts(nowEpoch, tz);
    let absDate = parseAbsDate(text) || parseHoliday(text, now);

    // ---- 6.6 多轮澄清：用上一轮已理解的锚点补全本轮（结构化合并，避免盲目拼接丢上下文） ----
    let contradiction = false;
    let ctxLabel = null;
    if (opts && opts.context) {
      const c = opts.context;
      ctxLabel = c.label || null;
      const curHasDay = weekTarget !== null || dayOffset !== 0 || absDate;
      if (!curHasDay) {
        if (c.weekTarget != null) { weekTarget = c.weekTarget; weekNext = !!c.weekNext; }
        else if (c.dayOffset) { dayOffset = c.dayOffset; }
        else if (c.absDate) { absDate = { year: c.absDate.year, month: c.absDate.month, day: c.absDate.day }; }
      }
      if (recurrence === 'none' && c.recurrence && c.recurrence !== 'none') recurrence = c.recurrence;
      if (leadMin === null && c.lead_minutes) leadMin = c.lead_minutes;
      // 矛盾：已有日期锚点，但本轮只给了"相对时长"而无具体时刻 → 需要具体几点，不能静默丢弃日期
      const ctxHasDay = c.weekTarget != null || c.dayOffset || c.absDate;
      if (ctxHasDay && relMatch && hour === null) { contradiction = true; relMatch = null; }
    }

    // ---- 6.7 结束条件（仅重复闹钟） ----
    let endObj = null, endRaw = null;
    if (recurrence !== 'none') {
      const e = parseEnd(text, now);
      if (e) {
        endObj = e.end; endRaw = e.raw;
        // 结束日期不污染闹钟自身锚点（避免"到10月1日为止"被误当作闹钟日期）
        if (endObj.type === 'date') { absDate = null; weekTarget = null; weekNext = false; dayOffset = 0; }
      }
    }

    // ---- 7. 组合时间 ----
    let target = null;

    if (absDate) {
      // 绝对日期优先；未给年份/月份时按"已过期则顺延"补全（基于用户在 tz 下的"今天"）
      let year = absDate.year, month = absDate.month, day = absDate.day;
      const todayNum = todayTz.y * 10000 + todayTz.mo * 100 + todayTz.d;
      if (year === undefined) {
        year = todayTz.y;
        if (year * 10000 + month * 100 + day < todayNum) year += 1;
      }
      if (month === undefined) {
        month = todayTz.mo;
        if (year * 10000 + month * 100 + day < todayNum) {
          month += 1;
          if (month > 12) { month = 1; year += 1; }
        }
      }
      const base = new Date(year, month - 1, day);
      consumed.push(absDate.consumed);
      if (hour === null) {
        target = null;
      } else {
        let h = hour;
        if (todAdd === 12 && h < 12) h += 12;
        if (hour === 12 && todConsumed && /中午/.test(todConsumed)) h = 12;
        if (hour === 12 && todConsumed && /(凌晨|早上|上午)/.test(todConsumed)) h = 0;
        // 墙钟 → UTC：一律经 scheduler.wallToEpoch（按 tz 计算，含 DST 修正）
        target = new Date(sched().wallToEpoch(year, month, day, h, minute, tz));
        confidence = Math.max(confidence, 0.9);
      }
    } else if (relMatch) {
      let ms = 0;
      const n = relMatch.num;
      if (relMatch.unit.includes('秒')) ms = n * 1000;
      else if (relMatch.unit.includes('分')) ms = n * 60 * 1000;
      else if (relMatch.unit.includes('小时') || relMatch.unit.includes('钟头')) ms = n * 3600 * 1000;
      target = new Date(now.getTime() + ms);
      confidence = 0.9;
    } else {
      // 以用户在 tz 下的"今天"为基准，所有日历日步进走 scheduler.addDays，避免与闹钟时区错位
      let baseY = todayTz.y, baseM = todayTz.mo, baseD = todayTz.d;
      if (weekTarget !== null) {
        // 以「周一为一周起点」计算：本周X / 下周X / 裸写X
        const curMon = (new Date(Date.UTC(todayTz.y, todayTz.mo - 1, todayTz.d)).getUTCDay() + 6) % 7; // 周一=0 .. 周日=6
        const tgtMon = (weekTarget + 6) % 7;
        const daysToThisWeekX = tgtMon - curMon;        // 到"本周该星期"的天数（可为负）
        const todayNum = todayTz.y * 10000 + todayTz.mo * 100 + todayTz.d;
        const thisWeekX = sched().addDays(todayTz.y, todayTz.mo, todayTz.d, daysToThisWeekX);
        const thisWeekXNum = thisWeekX.y * 10000 + thisWeekX.mo * 100 + thisWeekX.d;
        let addDaysCount;
        if (weekNext) {
          addDaysCount = daysToThisWeekX + 7;                // 「下X」= 下一周的那一天
        } else if (thisWeekXNum >= todayNum) {
          addDaysCount = daysToThisWeekX;                    // 本周尚未过去 → 本周X
        } else {
          addDaysCount = daysToThisWeekX + 7;                // 本周已过 → 顺延到下周
        }
        const base = sched().addDays(todayTz.y, todayTz.mo, todayTz.d, addDaysCount);
        baseY = base.y; baseM = base.mo; baseD = base.d;
      } else {
        const base = sched().addDays(todayTz.y, todayTz.mo, todayTz.d, dayOffset);
        baseY = base.y; baseM = base.mo; baseD = base.d;
      }
      if (hour === null) {
        target = null;
      } else {
        let h = hour;
        if (todAdd === 12 && h < 12) h += 12;
        if (hour === 12 && todConsumed && /中午/.test(todConsumed)) h = 12;
        if (hour === 12 && todConsumed && /(凌晨|早上|上午)/.test(todConsumed)) h = 0;
        // 墙钟 → UTC：一律经 scheduler.wallToEpoch（按 tz 计算，含 DST 修正）
        target = new Date(sched().wallToEpoch(baseY, baseM, baseD, h, minute, tz));
        confidence = 0.85;
        if (todConsumed) confidence += 0.05;
      }
    }

    // ---- 7.5 提前提醒：触发时间前移 leadMin 分钟 ----
    if (leadMin !== null && target) {
      target = new Date(target.getTime() - leadMin * 60000);
      confidence = Math.max(confidence, 0.9);
    }

    // ---- 8. 标签提取 ----
    if (endRaw) consumed.push(endRaw);
    let label = text;
    consumed.forEach(c => { label = label.split(c).join(''); });
    const stop = /设置|设个|设为|设|一个?|闹钟|提醒我|提醒|叫我|叫醒|叫|帮我|请|需要|想|要|在|的|时间|时候|左右|大概|大约|之后|以后|后|来|去|做|干|一下|点个?|今|明|个|到|直到|直至|为止|结束|停止|持续|连续|坚持/g;
    label = label.replace(stop, '').replace(/\s+/g, '').trim();
    // 去除模糊时间词与残留指令词（待会/有空了/我/了…），避免多轮追问累加时污染 label
    label = label.replace(/(待会|等下|等一下|一会儿|一会|有空|回头|到时候|稍后|稍等|过会儿|随后|之后再说|改天|空了|方便时|我|了)/g, '').trim();

    // ---- 9. 结果组装 ----
    if (!target) {
      needsClarification = true;
      confidence = Math.min(confidence, 0.3);
      // 已理解日期/星期锚点但缺具体时刻 → 聚焦追问"几点"（而非笼统报错），并保留 partial 供下一轮合并
      const hasDayAnchor = weekTarget !== null || dayOffset !== 0 || absDate;
      let clarification;
      if (contradiction || hasDayAnchor) {
        const dayDesc = describeDay({ weekTarget, weekNext, dayOffset, absDate, recurrence });
        clarification = {
          type: 'time_of_day',
          question: contradiction ? (dayDesc + ' 需要一个具体时刻，例如：') : (dayDesc + ' 几点？例如：'),
          day: dayDesc,
          suggestions: ['上午9点', '下午3点', '晚上8点', '早上7点半']
        };
      } else {
        // 识别模糊时间词，生成聚焦追问（而非笼统报错），支撑多轮澄清对话
        const VAGUE = ['待会', '等下', '等一下', '一会儿', '一会', '有空', '回头', '到时候', '稍后', '稍等', '过会儿', '随后', '之后再说', '改天', '空了', '方便时'];
        const hit = VAGUE.find(w => text.includes(w));
        clarification = hit
          ? { type: 'time_anchor', question: `「${hit}」是多久后呢？告诉我具体时间，例如：`, suggestions: ['30分钟后', '1小时后', '今晚8点', '明天早上9点'] }
          : { type: 'unknown', question: '没听清具体时间，补充一下吧，比如「30分钟后」「明天8点」「下周一9点」。', suggestions: ['30分钟后', '1小时后', '明天8点', '下周一9点'] };
      }
      ambiguities.push(clarification.question);
      return {
        success: false, raw: text, alarm: null, intent: 'create',
        confidence: Number(confidence.toFixed(2)),
        needs_clarification: true, ambiguities, clarification,
        partial: buildPartial({ recurrence, weekTarget, weekNext, dayOffset, absDate, leadMin, label })
      };
    }

    const pad = n => String(n).padStart(2, '0');
    // 时区墙钟与偏移一律来自 scheduler（不新造时区换算）：日期/时间按 tz 墙钟，偏移按 tzOffsetAt
    const tp = sched().tzDateParts(target.getTime(), tz);            // tz 下的日历日 {y,mo,d}
    const whm = sched().wallClockAt(target.getTime(), tz).split(':'); // tz 下的墙钟 HH:MM
    const offMin = Math.round(sched().tzOffsetAt(tz, target.getTime()) / 60000);
    const sign = offMin >= 0 ? '+' : '-';
    const oh = pad(Math.floor(Math.abs(offMin) / 60));
    const om = pad(Math.abs(offMin) % 60);
    const iso = `${tp.y}-${pad(tp.mo)}-${pad(tp.d)}T${whm[0]}:${whm[1]}:00${sign}${oh}:${om}`;

    return {
      success: true, raw: text, intent: 'create',
      alarm: {
        timestamp: Math.floor(target.getTime() / 1000), // Unix 秒级时间戳（UTC）
        datetime: iso,
        date: `${tp.y}-${pad(tp.mo)}-${pad(tp.d)}`,
        time: `${whm[0]}:${whm[1]}`,
        recurrence: recurrence,
        timezone: tz,
        lead_minutes: leadMin || 0,
        end: endObj,
        label: label || ctxLabel || '(无备注)',
        enabled: true
      },
      confidence: Number(confidence.toFixed(2)),
      needs_clarification: false,
      ambiguities: []
    };
  }

  global.parseAlarm = parseAlarm;
  if (typeof module !== 'undefined' && module.exports) module.exports = { parseAlarm };

})(typeof window !== 'undefined' ? window : this);
