/* ============================================================
 * nlu.js — 闹钟 Agent 自然语言时间解析引擎（规则 + 词典）
 * 纯前端、零依赖、可离线运行。
 * 暴露全局函数 parseAlarm(text) -> JSON
 * ============================================================ */
(function (global) {
  'use strict';

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

  function parseAlarm(text, opts) {
    text = (text || '').trim();
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
    const now = (opts && opts.now != null) ? new Date(opts.now) : new Date();
    const absDate = parseAbsDate(text) || parseHoliday(text, now);

    // ---- 7. 组合时间 ----
    const tz = 'Asia/Shanghai';
    let target = null;

    if (absDate) {
      // 绝对日期优先；未给年份/月份时按"已过期则顺延"补全
      let year = absDate.year, month = absDate.month, day = absDate.day;
      const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (year === undefined) {
        year = now.getFullYear();
        if (new Date(year, month - 1, day) < today0) year += 1;
      }
      if (month === undefined) {
        month = now.getMonth() + 1;
        if (new Date(year, month - 1, day) < today0) {
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
        target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, minute, 0, 0);
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
      let base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (weekTarget !== null) {
        // 以「周一为一周起点」计算：本周X / 下周X / 裸写X
        const curMon = (now.getDay() + 6) % 7;          // 周一=0 .. 周日=6
        const tgtMon = (weekTarget + 6) % 7;
        const daysToThisWeekX = tgtMon - curMon;        // 到"本周该星期"的天数（可为负）
        const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thisWeekX = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToThisWeekX);
        let addDays;
        if (weekNext) {
          addDays = daysToThisWeekX + 7;                // 「下X」= 下一周的那一天
        } else if (thisWeekX >= today0) {
          addDays = daysToThisWeekX;                    // 本周尚未过去 → 本周X
        } else {
          addDays = daysToThisWeekX + 7;                // 本周已过 → 顺延到下周
        }
        base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + addDays);
      } else {
        base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
      }
      if (hour === null) {
        target = null;
      } else {
        let h = hour;
        if (todAdd === 12 && h < 12) h += 12;
        if (hour === 12 && todConsumed && /中午/.test(todConsumed)) h = 12;
        if (hour === 12 && todConsumed && /(凌晨|早上|上午)/.test(todConsumed)) h = 0;
        target = new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, minute, 0, 0);
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
    let label = text;
    consumed.forEach(c => { label = label.split(c).join(''); });
    const stop = /设置|设个|设为|设|一个?|闹钟|提醒我|提醒|叫我|叫醒|叫|帮我|请|需要|想|要|在|的|时间|时候|左右|大概|大约|之后|以后|后|来|去|做|干|一下|点个?|今|明|个/g;
    label = label.replace(stop, '').replace(/\s+/g, '').trim();
    // 去除模糊时间词与残留指令词（待会/有空了/我/了…），避免多轮追问累加时污染 label
    label = label.replace(/(待会|等下|等一下|一会儿|一会|有空|回头|到时候|稍后|稍等|过会儿|随后|之后再说|改天|空了|方便时|我|了)/g, '').trim();

    // ---- 9. 结果组装 ----
    if (!target) {
      needsClarification = true;
      confidence = Math.min(confidence, 0.3);
      // 识别模糊时间词，生成聚焦追问（而非笼统报错），支撑多轮澄清对话
      const VAGUE = ['待会', '等下', '等一下', '一会儿', '一会', '有空', '回头', '到时候', '稍后', '稍等', '过会儿', '随后', '之后再说', '改天', '空了', '方便时'];
      const hit = VAGUE.find(w => text.includes(w));
      const clarification = hit
        ? { type: 'time_anchor', question: `「${hit}」是多久后呢？告诉我具体时间，例如：`, suggestions: ['30分钟后', '1小时后', '今晚8点', '明天早上9点'] }
        : { type: 'unknown', question: '没听清具体时间，补充一下吧，比如「30分钟后」「明天8点」「下周一9点」。', suggestions: ['30分钟后', '1小时后', '明天8点', '下周一9点'] };
      ambiguities.push(clarification.question);
      return {
        success: false, raw: text, alarm: null,
        confidence: Number(confidence.toFixed(2)),
        needs_clarification: true, ambiguities, clarification
      };
    }

    const pad = n => String(n).padStart(2, '0');
    const off = -now.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const oh = pad(Math.floor(Math.abs(off) / 60));
    const om = pad(Math.abs(off) % 60);
    const iso = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}:00${sign}${oh}:${om}`;

    return {
      success: true, raw: text,
      alarm: {
        timestamp: Math.floor(target.getTime() / 1000), // Unix 秒级时间戳（UTC）
        datetime: iso,
        date: `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`,
        time: `${pad(target.getHours())}:${pad(target.getMinutes())}`,
        recurrence: recurrence,
        timezone: tz,
        lead_minutes: leadMin || 0,
        label: label || '(无备注)',
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
