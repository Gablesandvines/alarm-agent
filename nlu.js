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
    // 中文完整：YYYY年MM月DD日/号（日/号可选）。
    // 「的」必须吃下：之前 `\s*` 匹配不了连接词，「2019年的6月8号」会退化到下面的
    // 「MM月DD日」分支，把用户明写的年份整个丢掉（→ 2025-06-08，静默算错 6 年）。
    if ((m = text.match(/(\d{4})\s*年\s*(?:的\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)))
      return { year: +m[1], month: +m[2], day: +m[3], consumed: m[0] };
    // 中文月-日：MM月DD日/号（日/号必须）
    if ((m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)))
      return { month: +m[1], day: +m[2], consumed: m[0] };
    // 中文日-号：DD日/号
    if ((m = text.match(/(\d{1,2})\s*[日号]/)))
      return { day: +m[1], consumed: m[0] };
    return null;
  }

  /* ============================================================
   * 节日 / 农历 / 节气（P1，零依赖）
   *
   * 数据来源与许可：
   *   1) 农历年表 LUNAR_INFO 采用公开流传的「农历 1900—2100 年压缩年表（lunarInfo）」
   *      编码方式与 1900-01-31 基准日，取自 jjonline/calendar.js
   *      （《1900年至2100年公历、农历互转 Js 代码》，MIT 许可；同表亦见于多个 MIT / 公有领域实现）。
   *      本文件只收录 1900—2039 段：1900—2023 用于累计天数，2024—2039 为可查询年份。
   *   2) 节气采用同一族实现中的「均值太阳项公式」（sTermInfo 24 项毫秒偏移，基准 1900-01-06 02:05 UTC），
   *      该公式输出即北京时间的节气日期，2024—2035 区间与权威日历一致（见测试断言）。
   *   3) 母亲节/父亲节/感恩节按「某月第 N 个周 X」规则推算，无需年表。
   *
   * 覆盖年份 2024—2035。超出范围一律不猜：返回 outOfRange，由上层给出「年份超出支持范围」的澄清提示。
   * ============================================================ */
  const FEST_YEAR_MIN = 2024, FEST_YEAR_MAX = 2035;

  // 农历 1900—2039 年表（0x0 段 = 闰月月份，bit4-15 = 各月大小，bit16 = 闰月是否 30 天）
  const LUNAR_INFO = [
    0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
    0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
    0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
    0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
    0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
    0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
    0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
    0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
    0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
    0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
    0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
    0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
    0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
    0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45  // 2030-2039
  ];
  const LUNAR_BASE_UTC = Date.UTC(1900, 0, 31);   // 1900-01-31 = 农历 1900 年正月初一
  const DAY_MS = 86400000;

  /** 农历 y 年的闰月月份（0 = 无闰月） */
  function lunarLeapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf; }
  /** 农历 y 年闰月的天数（无闰月为 0） */
  function lunarLeapDays(y) { return lunarLeapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0; }
  /** 农历 y 年第 m 月（m=1..12）的天数 */
  function lunarMonthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29; }
  /** 农历 y 年的总天数 */
  function lunarYearDays(y) {
    let sum = 348;
    for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[y - 1900] & i) ? 1 : 0;
    return sum + lunarLeapDays(y);
  }
  /**
   * 农历 y 年 m 月 d 日 → 公历 {y, m, d}
   * @return {{y:number, m:number, d:number}|null} 超年表范围返回 null
   */
  function lunarToYmd(y, m, d) {
    if (y < 1900 || y > 2039) return null;
    let offset = 0;
    for (let i = 1900; i < y; i++) offset += lunarYearDays(i);
    const leap = lunarLeapMonth(y);
    for (let i = 1; i < m; i++) {
      offset += lunarMonthDays(y, i);
      if (leap && i === leap) offset += lunarLeapDays(y);
    }
    offset += d - 1;
    const dt = new Date(LUNAR_BASE_UTC + offset * DAY_MS);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  // 24 节气：名称 → sTermInfo 下标（0=小寒 … 23=冬至）
  const S_TERM_NAMES = {
    '小寒': 0, '大寒': 1, '立春': 2, '雨水': 3, '惊蛰': 4, '春分': 5, '清明': 6, '谷雨': 7,
    '立夏': 8, '小满': 9, '芒种': 10, '夏至': 11, '小暑': 12, '大暑': 13, '立秋': 14, '处暑': 15,
    '白露': 16, '秋分': 17, '寒露': 18, '霜降': 19, '立冬': 20, '小雪': 21, '大雪': 22, '冬至': 23,
    '清明节': 6, '冬至节': 23
  };
  const S_TERM_INFO = [
    0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551, 218072, 240693,
    263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758
  ];
  /** 公历 year 年第 n 个节气 → {y, m, d}（公式输出即北京时间日期） */
  function solarTermYmd(year, n) {
    const ms = 31556925974.7 * (year - 1900) + S_TERM_INFO[n] * 60000 + Date.UTC(1900, 0, 6, 2, 5);
    const dt = new Date(ms);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }

  // 阳历固定节日
  const SOLAR_FESTIVALS = {
    '元旦': [1, 1], '元旦节': [1, 1], '情人节': [2, 14], '妇女节': [3, 8], '植树节': [3, 12],
    '劳动节': [5, 1], '劳动': [5, 1], '五一': [5, 1], '青年节': [5, 4], '儿童节': [6, 1],
    '建军节': [8, 1], '教师节': [9, 10], '国庆': [10, 1], '国庆节': [10, 1],
    '圣诞': [12, 25], '圣诞节': [12, 25]
  };
  // 农历节日（月, 日）；除夕单独按「春节前一天」推算（腊月可能是 29 天）
  const LUNAR_FESTIVALS = {
    '春节': [1, 1], '元宵': [1, 15], '元宵节': [1, 15], '端午': [5, 5], '端午节': [5, 5],
    '七夕': [7, 7], '中秋': [8, 15], '中秋节': [8, 15], '重阳': [9, 9], '重阳节': [9, 9]
  };
  // 按星期推算：{ m: 月, w: 星期几(0=周日), n: 第几个 }
  const WEEK_FESTIVALS = {
    '母亲节': { m: 5, w: 0, n: 2 },   // 5 月第 2 个周日
    '父亲节': { m: 6, w: 0, n: 3 },   // 6 月第 3 个周日
    '感恩节': { m: 11, w: 4, n: 4 }   // 11 月第 4 个周四
  };

  /** 公历 year 年 month 月第 n 个星期 w 的日期 */
  function weekFestivalYmd(year, month, w, n) {
    const first = new Date(Date.UTC(year, month - 1, 1));
    const delta = (w - first.getUTCDay() + 7) % 7;
    return { y: year, m: month, d: 1 + delta + (n - 1) * 7 };
  }

  /** 名称表：长名优先（避免「中秋节」被「中秋」截断） */
  const FEST_NAMES = (function () {
    const names = [];
    [SOLAR_FESTIVALS, LUNAR_FESTIVALS, WEEK_FESTIVALS, S_TERM_NAMES].forEach(function (o) {
      for (const k in o) names.push(k);
    });
    names.push('除夕');
    names.sort(function (a, b) { return b.length - a.length; });
    return names;
  })();

  /** 节日名称 + 公历年份 → 公历日期 */
  function festivalYmd(name, year) {
    let m;
    if (name === '除夕') {
      const cny = lunarToYmd(year, 1, 1);
      if (!cny) return null;
      const dt = new Date(Date.UTC(cny.y, cny.m - 1, cny.d) - DAY_MS);
      return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
    }
    if ((m = SOLAR_FESTIVALS[name])) return { y: year, m: m[0], d: m[1] };
    if ((m = LUNAR_FESTIVALS[name])) return lunarToYmd(year, m[0], m[1]);
    if ((m = WEEK_FESTIVALS[name])) return weekFestivalYmd(year, m.m, m.w, m.n);
    if (S_TERM_NAMES[name] !== undefined) return solarTermYmd(year, S_TERM_NAMES[name]);
    return null;
  }

  const ymdNum = function (o) { return o.y * 10000 + o.m * 100 + o.d; };
  const inFestYears = function (y) { return y >= FEST_YEAR_MIN && y <= FEST_YEAR_MAX; };

  /**
   * 节日/农历/节气识别。返回与 absDate 同结构的 { year, month, day, consumed }（已解析成具体公历日）。
   * 支持修饰：前一天 / 后一天 / 当天（那天、当日）。
   * @param {string} text 原始文本（不掩蔽，节日名不在掩蔽词典内）
   * @param {{y:number, mo:number, d:number}} todayTz 用户在目标时区下的「今天」
   * @return {{year:number, month:number, day:number, consumed:string}|{outOfRange:boolean, name:string, year:number}|null}
   */
  function parseHoliday(text, todayTz) {
    let name = null;
    for (let i = 0; i < FEST_NAMES.length; i++) {
      if (text.indexOf(FEST_NAMES[i]) >= 0) { name = FEST_NAMES[i]; break; }
    }
    if (!name) return null;

    // 年份：显式 4 位 > 后年/明年/今年 > 自动取「最近一次未过期」
    let year = null, m;
    if ((m = text.match(/(\d{4})\s*年/))) year = parseInt(m[1], 10);
    else if (/后年/.test(text)) year = todayTz.y + 2;
    else if (/明年|次年/.test(text)) year = todayTz.y + 1;
    else if (/今年|本年|这年/.test(text)) year = todayTz.y;

    let ymd = null;
    if (year !== null) {
      if (!inFestYears(year)) return { outOfRange: true, name: name, year: year };
      ymd = festivalYmd(name, year);
      if (!ymd) return { outOfRange: true, name: name, year: year };
    } else {
      // todayTz 的字段是 {y, mo, d}（scheduler.tzDateParts 的约定），不能直接喂 ymdNum
      const todayNum = todayTz.y * 10000 + todayTz.mo * 100 + todayTz.d;
      for (let i = 0; i <= 2; i++) {
        const y = todayTz.y + i;
        if (!inFestYears(y)) continue;
        const cand = festivalYmd(name, y);
        if (cand && ymdNum(cand) >= todayNum) { ymd = cand; break; }
      }
      if (!ymd) return { outOfRange: true, name: name, year: todayTz.y };
    }

    // 修饰：前一天 / 后一天（当天、那天 = 原日）
    let delta = 0;
    if (/前一天|前一日|之前一天/.test(text)) delta = -1;
    else if (/后一天|后一日|隔天/.test(text)) delta = 1;
    if (delta) {
      const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d) + delta * DAY_MS);
      ymd = { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
    }
    if (!inFestYears(ymd.y)) return { outOfRange: true, name: name, year: ymd.y };
    return { year: ymd.y, month: ymd.m, day: ymd.d, consumed: name };
  }

  // 多轮澄清：把已理解的日期/星期锚点描述成中文，用于聚焦追问
  function describeDay(o) {
    if (o.absDate) return (o.absDate.month || '?') + '月' + (o.absDate.day || '?') + '日';
    if (o.weekTarget != null) {
      const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return (o.weekNext ? '下' : '本') + names[o.weekTarget];
    }
    if (o.dayOffset) {
      const map = { '1': '明天', '2': '后天', '3': '大后天', '-1': '昨天', '-2': '前天', '-3': '大前天' };
      return map[String(o.dayOffset)] || '那天';
    }
    return '那天';
  }
  /**
   * 把 absDate 补全成具体公历日：未给年份 → 今年（已过期则顺延）；未给月份 → 本月（已过期则次月）。
   * @param {{year?:number, month?:number, day:number}} absDate 绝对日期锚点
   * @param {{y:number, mo:number, d:number}} todayTz 用户在目标时区下的「今天」
   * @return {{y:number, mo:number, d:number}}
   */
  function resolveAbsYmd(absDate, todayTz) {
    let year = absDate.year, month = absDate.month;
    const day = absDate.day;
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
    return { y: year, mo: month, d: day };
  }

  /**
   * 把「星期锚点」解析成具体公历日（以**周一为一周起点**）。
   * 单独抽出来的原因：这个日历日既要用于算触发时刻，又要作为 `date` 字段返回，
   * 两处必须是同一个函数算出来的同一个值，否则「时刻对了但 date 差一天」这类
   * 契约矛盾会再次出现。全程只用 scheduler.addDays 做日历步进（DST 安全）。
   * @param {number} weekTarget 0=周日 .. 6=周六
   * @param {boolean} weekNext true=「下X」，false=「本X / 裸写X」（本周已过则顺延下周）
   * @param {{y:number, mo:number, d:number}} todayTz 用户在目标时区下的「今天」
   * @return {{y:number, mo:number, d:number}}
   */
  function weekAnchorYmd(weekTarget, weekNext, todayTz) {
    const curMon = (new Date(Date.UTC(todayTz.y, todayTz.mo - 1, todayTz.d)).getUTCDay() + 6) % 7; // 周一=0 .. 周日=6
    const tgtMon = (weekTarget + 6) % 7;
    const daysToThisWeekX = tgtMon - curMon;        // 到「本周该星期」的天数（可为负）
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
    return sched().addDays(todayTz.y, todayTz.mo, todayTz.d, addDaysCount);
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
  /**
   * 时区入参的兜底解析：非法 / 空 / 非字符串一律静默回退上海。
   * 只用 Intl 做「是否合法」的校验，不参与任何换算（换算仍走 scheduler）。
   * 为什么要兜底：cancel/modify/query 分支在意图识别后就 return 了，一旦在这里抛，
   * 整个「取消/查询」会 500（/api/parse 没有 invalid_timezone 校验，前端 tz 也可能来自 localStorage 脏值）。
   * 注意这不动 /v1/parse 的 400 invalid_timezone 语义——那是 server 层 resolveEffectiveTz 的职责。
   * @param {*} tz 期望是 IANA 时区名
   * @return {string} 可用的 IANA 时区名（至少 'Asia/Shanghai'）
   */
  function safeTz(tz) {
    const s = (typeof tz === 'string' && tz.trim()) ? tz.trim() : 'Asia/Shanghai';
    try { new Intl.DateTimeFormat('en-US', { timeZone: s }); return s; }
    catch (_) { return 'Asia/Shanghai'; }
  }
  const DAYOFF = { '今天': 0, '今日': 0, '今晚': 0, '今早': 0, '今晨': 0, '明天': 1, '明早': 1, '明晨': 1, '明晚': 1, '明日': 1, '后天': 2, '大后天': 3, '昨天': -1, '前天': -2, '大前天': -3, '大前日': -3 };
  // 日锚点按「key 长度降序」匹配：「大后天」必须先于「后天」命中，否则会算成 +2 天
  // （不能直接改 DAYOFF 字面量顺序：主路径是有序 if-else，且 parseEndDate 依赖既有顺序）
  function dayoffKeysByLen() {
    return Object.keys(DAYOFF).sort((a, b) => b.length - a.length);
  }

  /* ---------------- P0 误报过滤：非时刻词掩蔽 ----------------
   * 「两点意见」「快一点」「身份证4590…」「一日之计在于晨」「黎明主演的电影」这类文本里的
   * 数词 + 点 / 日并不表示时刻，直接喂给时刻正则会误报 02:00 / 01:00。
   * 做法：把可疑片段替换成等长占位符，得到「只保留可信时刻词」的文本，
   * 下游时刻正则（matchClock）只吃这份文本；原文仍用于 label 与其它锚点，
   * 因此占位符与原文同长，m[0] 依然能在原文中精确切出。
   * 判定一律基于「相邻词搭配」而非「禁止某字」，保证合法时刻（两点开会 / 下午两点 /
   * 十一点提醒我 / 一点钟）不受影响。 */
  const MASK_CHAR = '\u3000';
  // 「点」是量词时常跟的名词：两点意见 / 三点建议 / 一点补充
  const QUANT_NOUN_SRC = '意见|建议|想法|要求|希望|问题|内容|事项|说明|看法|观点|理由|原因|补充|原则|体会|感受|经验|心得|计划|安排|步骤|方法|技巧|规则|做法|标准|好处|坏处|细节|教训|启示|总结|反思|情况|意思|收获|要点|重点|难点|需求|事情|东西';
  // 「点」是量词时常出现的列举动词：再说两点 / 讲讲三点 / 提一点
  // （刻意不含裸「说」，避免「他说三点见」这类真实时刻被误杀）
  const QUANT_VERB_SRC = '再说|说说|讲讲|讲|提出|提|补充|列出|列举|列|有';
  // 副词「一点 / 半点」：快一点、早一点、慢一点、一点点、有一点、一点都不、一点也不…
  const ADV_POINT_SRC = '一点点|一点儿|一点(?:都|也|不|没)|(?:快|慢|早|晚|多|少|好|差|高|低|有|稍|稍微|提前|再)\\s*一?\\s*点{1,2}';
  // 小数 / 算术 / 温度：「零点五」「减八点八」「调高24点5度」里的「点」是小数点，不是时刻
  const DECIMAL_SRC = '(?:减去?|加上?|乘以?|除以?)\\s*[0-9零一二两三四五六七八九十]{1,3}\\s*点[0-9零一二两三四五六七八九]{1,2}'
    + '|点[0-9零一二两三四五六七八九]{1,2}\\s*(?:度|倍|毫升|升|米|公斤|千克|斤|℃|%|％)';
  // 成语：内含数词/日/天，容易被日期或时刻规则误吃
  const IDIOM_SRC = '一日之计在于晨|一年之计在于春|一寸光阴一寸金|三天打鱼两天晒网|三心二意|七上八下|四面八方|九牛一毛|十全十美|朝三暮四|不三不四|一举两得|三言两语|五花八门|五湖四海';
  // 「黎明」作人名（演艺语境）而非拂晓
  const NAME_LIKE_SRC = '黎明(?=主演|导演|演唱|的歌|专辑|电影|电视剧|先生|女士|老师|的粉丝)';
  // 时段词：出现时段词时，句首的列举动词不足以证明「点」是量词（下午两点开会）
  const TOD_SRC = '凌晨|拂晓|早上|早晨|上午|清早|中午|正午|下午|傍晚|黄昏|晚上|夜里|夜晚|深夜';

  function maskSpan(chars, start, end) {
    for (let i = start; i < end && i < chars.length; i++) chars[i] = MASK_CHAR;
  }

  /**
   * 把「非时刻词」从计时文本中掩蔽掉。
   * @param {string} t 原始文本
   * @return {string} 与入参等长的文本，非时刻片段被替换为全角空格
   */
  function maskNonTime(t) {
    if (!t) return t;
    const chars = String(t).split('');
    let m;
    // 1) 超长数字串（≥11 位）：手机号 / 身份证 / 卡号 / 订单号，绝不可能是时刻
    const longRe = /(\d{11,})/g;
    while ((m = longRe.exec(t))) maskSpan(chars, m.index, m.index + m[0].length);
    // 2) 成语
    const idiomRe = new RegExp('(' + IDIOM_SRC + ')', 'g');
    while ((m = idiomRe.exec(t))) maskSpan(chars, m.index, m.index + m[0].length);
    // 3) 人名词「黎明」+ 演艺语境
    const nameRe = new RegExp('(' + NAME_LIKE_SRC + ')', 'g');
    while ((m = nameRe.exec(t))) maskSpan(chars, m.index, m.index + m[0].length);
    // 4) 副词「一点 / 半点」（快一点、早一点、一点点、一点都不…）
    const advRe = new RegExp('(' + ADV_POINT_SRC + ')', 'g');
    while ((m = advRe.exec(t))) maskSpan(chars, m.index, m.index + m[0].length);
    // 4.5) 小数 / 算术 / 温度（零点五、减八点八、调高24点5度）
    const decRe = new RegExp('(' + DECIMAL_SRC + ')', 'g');
    while ((m = decRe.exec(t))) maskSpan(chars, m.index, m.index + m[0].length);
    // 5) 量词「点」：点后紧跟量词名词，或点前是列举动词且全句无时段词
    const hasTod = new RegExp('(?:' + TOD_SRC + ')').test(t);
    const quantNounRe = new RegExp('^(?:' + QUANT_NOUN_SRC + ')');
    const quantVerbRe = new RegExp('(?:' + QUANT_VERB_SRC + ')\\s*$');
    const pointRe = /(?:[一二两三四五六七八九十]|\d{1,2})\s*点/g;
    while ((m = pointRe.exec(t))) {
      const endIdx = m.index + m[0].length;
      const isNoun = quantNounRe.test(t.slice(endIdx));
      const isVerb = !hasTod && quantVerbRe.test(t.slice(0, m.index));
      if (isNoun || isVerb) maskSpan(chars, m.index, endIdx);
    }
    return chars.join('');
  }

  /* ---------------- 时刻词统一解析（中文数字修复） ----------------
   * 小时：数字（1..24）/ 「十」「十一」「二十三」等中文数词 / 单个中文数字（含「零」「两」）
   * 分钟：「半」=30；「N刻」=N×15（一刻 15、两刻 30、三刻 45、1刻 15）；「N分」；中文「十五分」
   * 注意：`{1,3}刻` 必须排在 `\d{1,2}\s*分?` 之前，否则「3点1刻」会把 1 吃成 1 分钟。 */
  const HOUR_SRC = '(\\d{1,2}|[一二两三四五六七八九]?十[一二三四五六七八九]?|[零一二两三四五六七八九])';
  const MIN_SRC = '(半|[零一二两三四五六七八九十\\d]{1,3}\\s*刻|[零一二两三四五六七八九十]{1,3}\\s*分|\\d{1,2}\\s*分?)?';
  const CLOCK_RE = new RegExp(HOUR_SRC + '\\s*点\\s*' + MIN_SRC);
  const CLOCK_RE_ALL = new RegExp(CLOCK_RE.source, 'g');
  const COLON_RE = /(\d{1,2})[:：](\d{1,2})/;

  /**
   * 解析「点」之后的分钟片段。
   * @param {string|undefined} tail 形如「半」「一刻」「两刻」「3刻」「15分」「十五分」
   * @return {number} 分钟（0..59）
   */
  function parseMinuteTail(tail) {
    if (tail === undefined || tail === null) return 0;
    const s = String(tail).replace(/\s+/g, '');
    if (!s) return 0;
    if (s === '半') return 30;
    let m;
    if ((m = s.match(/^([零一二两三四五六七八九十\d]{1,3})刻$/))) {
      const k = cnNum(m[1]);
      // 一刻 15 / 两刻 30 / 三刻 45；四刻及以上不是常用说法，按 0 处理
      return (k === 1 || k === 2 || k === 3) ? k * 15 : 0;
    }
    if ((m = s.match(/^([零一二两三四五六七八九十]{1,3})分$/))) {
      const n = cnNum(m[1]);
      return n === null ? 0 : n;
    }
    if ((m = s.match(/^(\d{1,2})分?$/))) return parseInt(m[1], 10);
    return 0;
  }

  /* ---------------- 无分隔钟点（0900 / 1830 / 830 / 930） ----------------
   * 中文口语常把「9:00」说成「0900」、「8 点半」写成「830」。这类裸数字串与
   * 数量/年份/金额同形，所以**必须**有上下文锚点才认，宁可漏判不可误判：
   *   ① 只认 3 位 HMM（小时首位 1–9）与 4 位 HHMM（小时 00–23），分钟必须 00–59；
   *   ② 数字串左侧不能紧邻数字，右侧不能紧跟量词（年/月/号/日/元/块/万…）；
   *   ③ 4 位落在 1900–2099 一律按公历年份处理，不当时刻（「2025」「2015」不动）；
   *   ④ 数字串前 8 个字内必须出现时间语境词（时段/日锚点/星期/年月日），否则不认。
   * 时段校正（下午 830 → 20:30）仍由 correctHour 统一处理，本函数只负责切出 h/m。 */
  const BARE_CLOCK_ANCHOR_SRC = '凌晨|拂晓|早上|早晨|上午|清早|中午|正午|下午|傍晚|黄昏|晚上|夜里|夜晚|深夜'
    + '|今天|今日|明天|明早|明晨|明晚|后天|大后天|昨天|前天|次日'
    + '|周[一二三四五六日天]|星期|礼拜'
    + '|[\\d一二两三四五六七八九十]+\\s*月[\\d一二两三四五六七八九十]+\\s*[号日]'
    + '|年|号|日';
  const BARE_CLOCK_ANCHOR_RE = new RegExp('(?:' + BARE_CLOCK_ANCHOR_SRC + ')');
  // 数字串后紧跟这些量词 → 是数量/金额/年份，不是钟点
  const BARE_CLOCK_TAIL_RE = /^\s*(?:年|月|号|日|元|块|万|亿|人|个|岁|次|位|台|件|条|张|斤|米|吨|%|％|℃|度)/;
  const BARE_CLOCK_RE = /(\d{3,4})(?!\d)/g;
  const BARE_CLOCK_ANCHOR_WINDOW = 8;   // 向前回看的字数

  /**
   * 识别无分隔钟点（0900 / 1830 / 830 / 930）。
   * @param {string} t 已掩蔽的文本
   * @return {{hour:number, minute:number, consumed:string}|null}
   */
  function matchBareClock(t) {
    if (!t) return null;
    let m;
    BARE_CLOCK_RE.lastIndex = 0;
    while ((m = BARE_CLOCK_RE.exec(t))) {
      const digits = m[1];
      const start = m.index;
      const end = start + digits.length;
      // 左侧紧邻数字 → 只是长数字串的一截，跳过
      if (start > 0 && /\d/.test(t.charAt(start - 1))) continue;
      // 右侧紧跟量词 → 数量/年份
      if (BARE_CLOCK_TAIL_RE.test(t.slice(end))) continue;
      const hour = parseInt(digits.length === 3 ? digits.charAt(0) : digits.slice(0, 2), 10);
      const minute = parseInt(digits.length === 3 ? digits.slice(1) : digits.slice(2), 10);
      // 4 位落在 1900–2099 视为年份
      if (digits.length === 4 && hour >= 19 && hour <= 20) continue;
      if (hour > 23) continue;
      if (digits.length === 3 && hour < 1) continue;
      if (minute > 59) continue;
      // 上下文锚点：前 8 字内必须有时间语境词
      const before = t.slice(Math.max(0, start - BARE_CLOCK_ANCHOR_WINDOW), start);
      if (!BARE_CLOCK_ANCHOR_RE.test(before)) continue;
      return { hour: hour, minute: minute, consumed: digits };
    }
    return null;
  }

  /* ---------------- 「过 / 差 / 零」分钟表达 ----------------
   * 中文口语报时刻有三种说法，后缀不在「点」后面，普通 CLOCK_RE 只吃到「十点」：
   *   ① 顺读 十点过六分 = 10:06；十点过一刻 = 10:15（过 M分 → H:M，过 M刻 → H:M×15）
   *   ② 逆读 十点差五分 = 09:55；十点差一刻 = 09:45（差 M分 → (H-1):(60-M)）
   *   ③ 前置 差五分十点 = 09:55（与 ② 同义，只是「差」在小时前）
   *   ④ 零头 十点零六分 = 10:06；十点零六 = 10:06（零 M分 → H:0M）
   * 边界：差 要求 H≥1（H=0 要跨日，不做）；M 必须在 1..59（差60分/过60分 不认，
   * 四刻=60 同理不认）；「十点过」「十点差」后面没有分钟词 → 不匹配，交回 CLOCK_RE 出 10:00。 */
  const OFFSET_MPART_SRC = '(?:[零一二两三四五六七八九十\\d]{1,3}\\s*刻'
    + '|[零一二两三四五六七八九十]{1,3}\\s*分'
    + '|\\d{1,2}\\s*分)';
  const CLOCK_AFTER_RE = new RegExp(HOUR_SRC + '\\s*点\\s*过\\s*(' + OFFSET_MPART_SRC + ')');
  const CLOCK_BEFORE_RE = new RegExp(HOUR_SRC + '\\s*点\\s*差\\s*(' + OFFSET_MPART_SRC + ')');
  const CLOCK_QIAN_RE = new RegExp('差\\s*(' + OFFSET_MPART_SRC + ')\\s*' + HOUR_SRC + '\\s*点');
  const CLOCK_LING_RE = new RegExp(HOUR_SRC + '\\s*点\\s*零\\s*([一二两三四五六七八九]|[1-9])\\s*分?');
  // 取消/修改路径里把「过六分 / 差一刻 / 零六分」这类残留片段一并抹掉
  const OFFSET_RESIDUE_RE = /(?:过|差)\s*(?:[零一二两三四五六七八九十\d]{1,3}\s*刻|[零一二两三四五六七八九十\d]{1,3}\s*分)|零\s*(?:[一二两三四五六七八九]|[1-9])\s*分?/g;

  /**
   * 解析「过 / 差」后面的分钟片段（不带「点」）。
   * @param {string} part 形如「六分」「一刻」「30分」「十五分」
   * @return {number|null} 分钟偏移（1..59 由调用方校验），无法解析返回 null
   */
  function parseOffsetMinutes(part) {
    if (!part) return null;
    const s = String(part).replace(/\s+/g, '');
    if (/刻$/.test(s)) {
      const k = cnNum(s.slice(0, -1));
      return k === null ? null : k * 15;
    }
    if (/分$/.test(s)) {
      const n = cnNum(s.slice(0, -1));
      return n === null ? null : n;
    }
    return null;
  }

  /**
   * 识别「过 / 差 / 零」口语句式里的时刻。
   * @param {string} t 已掩蔽的文本
   * @return {{hour:number, minute:number, consumed:string}|null}
   */
  function matchOffsetClock(t) {
    if (!t) return null;
    let m;
    // ① H点过 M分 / M刻 → H:M
    if ((m = t.match(CLOCK_AFTER_RE))) {
      const h = cnNum(m[1]);
      const off = parseOffsetMinutes(m[2]);
      if (h !== null && h >= 0 && h <= 24 && off !== null && off >= 1 && off <= 59) {
        return { hour: (h === 24 ? 0 : h), minute: off, consumed: m[0] };
      }
    }
    // ② H点差 M分 / M刻 → (H-1):(60-M)
    if ((m = t.match(CLOCK_BEFORE_RE))) {
      const h = cnNum(m[1]);
      const off = parseOffsetMinutes(m[2]);
      if (h !== null && h >= 1 && h <= 24 && off !== null && off >= 1 && off <= 59) {
        return { hour: h - 1, minute: 60 - off, consumed: m[0] };
      }
    }
    // ③ 差 M分 H点 → 同 ②
    if ((m = t.match(CLOCK_QIAN_RE))) {
      const h = cnNum(m[2]);
      const off = parseOffsetMinutes(m[1]);
      if (h !== null && h >= 1 && h <= 24 && off !== null && off >= 1 && off <= 59) {
        return { hour: h - 1, minute: 60 - off, consumed: m[0] };
      }
    }
    // ④ H点零 M分 / H点零M → H:0M
    if ((m = t.match(CLOCK_LING_RE))) {
      const h = cnNum(m[1]);
      const mm = cnNum(m[2]);
      if (h !== null && h >= 0 && h <= 24 && mm !== null && mm >= 1 && mm <= 9) {
        return { hour: (h === 24 ? 0 : h), minute: mm, consumed: m[0] };
      }
    }
    return null;
  }

  /**
   * 从文本中抽取一个时刻（先掩蔽非时刻词，再走统一时刻正则）。
   * @param {string} t 原始文本
   * @return {{hour:number, minute:number, consumed:string}|null} 未识别到时刻时返回 null
   */
  function matchClock(t) {
    const src = maskNonTime(t || '');
    let m;
    if ((m = src.match(COLON_RE))) {
      return { hour: parseInt(m[1], 10), minute: parseInt(m[2], 10), consumed: m[0] };
    }
    // 「过 / 差 / 零」必须排在 CLOCK_RE 之前：否则「十点过六分」只会吃到「十点」。
    // 「X:Y」「X点Y分」不受影响——它们的「点」后面紧跟分钟，不含 过/差/零 这三个字。
    const offset = matchOffsetClock(src);
    if (offset) return offset;
    if ((m = src.match(CLOCK_RE))) {
      const h = cnNum(m[1]);
      if (h === null) return null;
      // 小时超出 0..24 不是钟点（「27点」多为序号/温度），直接判为未识别
      if (h < 0 || h > 24) return null;
      return { hour: (h === 24 ? 0 : h), minute: parseMinuteTail(m[2]), consumed: m[0] };
    }
    // 兜底：无分隔钟点（显式的 «X点Y分» / «X:Y» 已经优先匹配完，不会走到这里）
    return matchBareClock(src);
  }

  /* ---------------- 时刻 + 时段校正的唯一入口 ----------------
   * create / cancel / modify / query 四条路径必须共用同一套「时段词校正」，
   * 否则「删除晚上8点的闹钟」会得到 08:00 而不是 20:00（前端按 time 字符串比对 → 删错闹钟）。
   * 这里把原先散落在 parseAlarm step5/step6 的「时段词识别 + correctHour」合成一处。 */
  /**
   * 解析文本里的时刻，并按时段词校正小时。
   * @param {string} t 原始文本
   * @param {number} [compoundTod] 复合日锚点携带的时段量（明晚/今晚 = 12）
   * @return {{hour:?number, minute:number, todAdd:number, todConsumed:?string,
   *           todNoon:boolean, timeConsumed:?string}} hour 为 null 表示未识别到时刻
   */
  function resolveClock(t, compoundTod) {
    let todAdd = compoundTod || 0, todConsumed = null, todNoon = false, m;
    if (todAdd === 0) {
      if ((m = t.match(/(凌晨|拂晓)/))) { todAdd = 0; todConsumed = m[0]; }
      else if ((m = t.match(/(早上|早晨|上午|清早)/))) { todAdd = 0; todConsumed = m[0]; }
      else if ((m = t.match(/(中午|正午)/))) { todAdd = 0; todConsumed = m[0]; todNoon = true; }
      else if ((m = t.match(/(下午|傍晚|黄昏)/))) { todAdd = 12; todConsumed = m[0]; }
      else if ((m = t.match(/(晚上|夜里|夜晚|深夜)/))) { todAdd = 12; todConsumed = m[0]; }
      else if ((m = t.match(/(晚|夜)/))) { todAdd = 12; todConsumed = m[0]; }
    }
    const c = matchClock(t);
    let hour = null, minute = 0, timeConsumed = null;
    if (c) {
      hour = correctHour(c.hour, todAdd, todConsumed, todNoon);   // 已校正，下游不要再校正一次
      minute = c.minute;
      timeConsumed = c.consumed;
    }
    return { hour: hour, minute: minute, todAdd: todAdd, todConsumed: todConsumed, todNoon: todNoon, timeConsumed: timeConsumed };
  }

  // 从文本中抽取一个时刻（HH:MM，含时段校正）。取消/查询/修改路径与创建路径同源。
  function matchTime(t) {
    const r = resolveClock(t, 0);
    return r.hour === null ? null : (pad2(r.hour) + ':' + pad2(r.minute));
  }

  /* ---------------- 复合相对时长（P1） ----------------
   * 只处理「秒 / 分钟 / 小时」量级；「天及更大」一律交给日期增量逻辑（6天后3点 是日期，不是时长）。
   * 支持：半小时=30min、一个半小时=90min、N个半小时=N×60+30、半天=12h、中文数字、多段相加
   * （2小时18分钟 = 138min）。前缀除「再过/过了/经过」外还接受「倒计时/倒数」
   * （倒计时30秒 = now + 30s，与「30秒后」完全同一条路径，秒级精度不变）。 */
  // 量化词必须**有界**：模型侧输入没有长度限制，`[一二两三四五六七八九十]+` 这种无界贪婪
  // 遇到 10k 大写中文数字串会退化成 O(n²)（实测 sufRe 490ms / parseAlarm 1078ms）。
  // 真实时长数字不超过 6 个中文字（二十三/一百零五这类也没问题，超出 6 字本身就不是时长），
  // 阿拉伯数字限 18 位（>16 位已超 Number.MAX_SAFE_INTEGER）。
  const DUR_NUM_SRC = '(?:\\d{1,18}|[一二两三四五六七八九十]{1,6})';
  const DUR_SEG_SRC = [
    DUR_NUM_SRC + '个半(?:小时|钟头)',   // 一个半小时 = 90min / 两个半小时 = 150min
    '半个?(?:小时|钟头)',                // 半小时 = 30min
    '半天',                              // 半天 = 12h
    DUR_NUM_SRC + '个?(?:小时|钟头)',
    DUR_NUM_SRC + '(?:分钟|分)',
    DUR_NUM_SRC + '(?:秒钟|秒)'
  ].join('|');
  // 段数同样有界：真实说法最多「N小时N分钟N秒」3 段，留 4 段余量；无界 `+` 会让
  // 「半小时半小时半小时…」这类串在每个起点上都重试一遍，同样是 O(n²)。
  const DUR_RUN_SRC = '(?:' + DUR_SEG_SRC + '){1,4}';
  const DUR_PRE_SRC = '(?:再过|过了|经过|倒计时|倒数)';
  const DUR_SUF_SRC = '(?:之后|以后|之内|以内|后|内)';
  // 相对时长上限（10 年）。既是「闹钟不可能这么远」的语义上限，
  // 也是防止 now + total 溢出 Date 可表示范围的护栏。
  const MAX_REL_MS = 10 * 365 * 86400000;

  /**
   * 把一段时长描述按片段求和。
   * @param {string} s 形如「2小时18分钟」「一个半小时」「半小时」「半天」
   * @return {number|null} 毫秒数；无法解析返回 null
   */
  function parseDurationMs(s) {
    let rest = String(s || '').replace(/\s+/g, '');
    let total = 0, m;
    let guard = 0;
    while (rest.length && guard++ < 12) {
      if ((m = rest.match(new RegExp('^(' + DUR_NUM_SRC + ')个半(?:小时|钟头)')))) {
        const n = cnNum(m[1]);
        if (n === null) return null;
        total += n * 3600000 + 1800000;          // N 个半小时 = N×60 + 30 分钟
      } else if ((m = rest.match(/^半个?(?:小时|钟头)/))) {
        total += 1800000;                        // 半小时
      } else if ((m = rest.match(/^半天/))) {
        total += 43200000;                       // 半天
      } else if ((m = rest.match(new RegExp('^(' + DUR_NUM_SRC + ')个?(?:小时|钟头)')))) {
        const n = cnNum(m[1]);
        if (n === null) return null;
        total += n * 3600000;
      } else if ((m = rest.match(new RegExp('^(' + DUR_NUM_SRC + ')(?:分钟|分)')))) {
        const n = cnNum(m[1]);
        if (n === null) return null;
        total += n * 60000;
      } else if ((m = rest.match(new RegExp('^(' + DUR_NUM_SRC + ')(?:秒钟|秒)')))) {
        const n = cnNum(m[1]);
        if (n === null) return null;
        total += n * 1000;
      } else {
        return null;
      }
      rest = rest.slice(m[0].length);
    }
    if (rest.length || !total) return null;
    // 量级护栏：相对时长上限 10 年。超过它的说法一定不是闹钟，而且 new Date(now + total)
    // 会溢出 Date 可表示范围（±8.64e15 ms），下游 tzDateParts 会抛 RangeError。
    // 实测 `9999999999999999分钟后` 直接抛 Invalid time value（500 级崩溃）。
    if (!Number.isFinite(total) || total > MAX_REL_MS) return null;
    return total;
  }

  /**
   * 从文本中识别相对时长表达式。
   * 三种形态：①「X + 后/以后/之后/内」（10分钟后、10分钟内）
   *           ②「再过/过了/经过/倒计时/倒数 + X」（再过十分钟叫我、倒计时30秒）
   *           ③「X (+的) + 倒计时/倒数」（设置30秒倒计时、30分钟倒计时）——时长在前、倒计时在后
   * @param {string} t 原始文本
   * @return {{ms:number, consumed:string}|null}
   */
  function matchRelDuration(t) {
    let m;
    // ① 有后缀（前缀可有可无）
    const sufRe = new RegExp(DUR_PRE_SRC + '?\\s*(' + DUR_RUN_SRC + ')\\s*' + DUR_SUF_SRC);
    if ((m = t.match(sufRe))) {
      const ms = parseDurationMs(m[1]);
      if (ms) return { ms: ms, consumed: m[0] };
    }
    // ② 只有前缀（「再过十分钟叫我」：中文口语常省略「后」）
    const preRe = new RegExp(DUR_PRE_SRC + '\\s*(' + DUR_RUN_SRC + ')');
    if ((m = t.match(preRe))) {
      const ms = parseDurationMs(m[1]);
      if (ms) return { ms: ms, consumed: m[0] };
    }
    // ③ 后置式：「(帮我设置)30秒(的)倒计时」——时长在前、倒计时在后。
    // 前置动词只放行这一串常见祈使词（且整个 match 必须含尾部「倒计时/倒数」），误伤面很小。
    // consumed 取整个 m[0]，让 label 剥离时把「设置」「倒计时」一起带走。
    const postRe = new RegExp(
      '(?:帮我|给我|请)?\\s*(?:设置|设|来个|来一个|定个|定|开个|开|开始|加个|加)?\\s*'
      + '(' + DUR_RUN_SRC + ')\\s*的?\\s*(?:倒计时|倒数)');
    if ((m = t.match(postRe))) {
      const ms = parseDurationMs(m[1]);
      if (ms) return { ms: ms, consumed: m[0] };
    }
    return null;
  }

  /**
   * 时段词对小时数的校正。
   * 凌晨/早上/上午 12点 → 0点；下午/晚上 h<12 → +12；中午 1~3 点 → +12（中午一点=13:00）。
   * 中午 11/12 点保持原值（中午十一点=11:00、中午十二点=12:00）。
   * @param {number} hour 解析出的小时
   * @param {number} todAdd 时段附加量（0 或 12）
   * @param {?string} todConsumed 命中的时段词
   * @param {boolean} todNoon 是否为「中午/正午」
   * @return {number} 校正后小时
   */
  function correctHour(hour, todAdd, todConsumed, todNoon) {
    let h = hour;
    if (todAdd === 12 && h < 12) h += 12;
    if (h === 12 && todConsumed && /(凌晨|早上|上午)/.test(todConsumed)) h = 0;
    if (todNoon && h >= 1 && h <= 3) h += 12;
    return h;
  }
  // 「每晚/每早/每午/每晨」在口语里等价于「每天」（每晚8点提醒我 = 每天20:00）
  const DAILY_SRC = '(?:每天|每日|每一天|每晚|每早|每午|每晨)';
  // 重复规则在 label 里要剥掉的写法（与上面保持一致，避免「每晚」残留在备注里）
  // 带星期字符的写法必须排在裸「每周 / 周X」之前，否则「每周二」会残留一个「二」、「下周一」残留「下」
  const REC_STRIP_SRC = '(?:每天|每日|每一天|每晚|每早|每午|每晨|工作日|周末'
    + '|(?:每周|每星期|每个礼拜)[一二三四五六日天七\\d]'
    + '|(?:下个?|下星期|下礼拜|下周|本个?|本星期|本礼拜|本周)[一二三四五六日天七]'
    + '|(?:周|星期|礼拜)[一二三四五六日天七]|周一到周五|星期一到星期五'
    + '|每周|每星期|每个礼拜)';
  function matchRecurrence(t) {
    let m;
    if ((m = t.match(new RegExp(DAILY_SRC)))) return 'daily';
    if ((m = t.match(/(工作日|周一到周五|星期一到星期五)/))) return 'weekdays';
    if ((m = t.match(/(周末|周六周日|星期六星期天)/))) return 'weekend';
    if ((m = t.match(/(每周|每星期|每个礼拜)([一二三四五六日天七\d])/))) return 'weekly:' + weekNum(m[2]);
    return null;
  }
  /**
   * 取消/查询：从「被操作对象描述」中抽取匹配条件。
   * 时刻走 resolveClock（含时段校正），否则「删除晚上8点的闹钟」会得到 08:00 而删错闹钟。
   * @param {string} t 被操作对象描述
   * @param {{tz:string, nowEpoch:number, todayTz:{y:number, mo:number, d:number}}} ctx 时区上下文
   * @return {Object} match 条件
   */
  function extractMatch(t, ctx) {
    const match = {};
    if (/所有|全部|都|每一个|所有闹钟|全部闹钟/.test(t)) match.all = true;
    const clk = resolveClock(t, 0);
    if (clk.hour !== null) match.time = pad2(clk.hour) + ':' + pad2(clk.minute);
    const rec = matchRecurrence(t); if (rec) match.recurrence = rec;
    // 日期增量按「用户在 tz 下的今天」做纯 UTC 日历算术（不用本地 new Date()，避免 UTC 容器下错位）
    const today = (ctx && ctx.todayTz) || sched().tzDateParts(Date.now(), 'Asia/Shanghai');
    const dayKeys = dayoffKeysByLen();
    for (const k of dayKeys) {
      if (t.includes(k)) {
        const dt = new Date(Date.UTC(today.y, today.mo - 1, today.d) + DAYOFF[k] * 86400000);
        match.date = dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
        break;
      }
    }
    let rest = t.replace(/(查看|查一下|列出|显示|看一下|看下|告诉我|取消|删掉|删除|去掉|移除|撤销|关掉|改成|改为|调整为|改到|换为|换成|设成|调成|更新为|把|将|这个|那个|我的|我|的|闹钟|提醒|所有|全部|都|一个|那|这|就|请|帮|一下|吧|了|也)/g, '');
    // 去掉已被 time/recurrence/date 消费掉的文本（含时段词，避免 label 残留「晚上」）
    // 顺序：先剥时刻片段，再剥日锚点（明晚/今晚），最后剥时段词——否则「明晚」会先被剥成「明」
    rest = rest.replace(/(\d{1,2})[:：]\d{1,2}/g, '').replace(CLOCK_RE_ALL, '').replace(OFFSET_RESIDUE_RE, '');
    if (clk.timeConsumed) rest = rest.split(clk.timeConsumed).join('');
    for (const k of dayKeys) rest = rest.split(k).join('');
    // 剥查询套话（「我的闹钟有哪些」不该留下 label）；但「查看看书的闹钟」的「看书」要保住
    rest = rest.replace(/(有哪些|有什么|多少个|几个|列表|清单|在吗|都有|呢|查看|查一下|列出|显示|看一下|看下|告诉我)/g, '');
    rest = rest.replace(new RegExp(REC_STRIP_SRC, 'g'), '');
    if (clk.todConsumed) rest = rest.split(clk.todConsumed).join('');
    rest = rest.replace(/\s+/g, '').trim();
    if (rest) match.label = rest;
    return match;
  }
  // 修改：从「新值描述」中抽取待更新字段
  function extractUpdate(spec, ctx) {
    const u = {};
    const clk = resolveClock(spec, 0);
    if (clk.hour !== null) u.time = pad2(clk.hour) + ':' + pad2(clk.minute);
    const rec = matchRecurrence(spec); if (rec) u.recurrence = rec;
    let m;
    if ((m = spec.match(/提前\s*(半|一|两|二|三|四|五|六|七|八|九|十|\d+)\s*(分钟|分|个?小时|小时|钟头)/))) {
      const isHalf = m[1] === '半'; const n = isHalf ? 30 : cnNum(m[1]);
      u.lead_minutes = isHalf ? 30 : ((m[2].includes('小时') || m[2].includes('钟头')) ? n * 60 : n);
    }
    let rest = spec.replace(/(改成|改为|调整为|改到|换为|换成|设成|调成|更新为|把|将|这个|那个|我的|我|的|闹钟|提醒|提前|所有|全部|都|一个|那|这|就|请|帮|一下|吧|了|也)/g, '');
    rest = rest.replace(/(\d{1,2})[:：]\d{1,2}/g, '').replace(CLOCK_RE_ALL, '').replace(OFFSET_RESIDUE_RE, '');
    if (clk.timeConsumed) rest = rest.split(clk.timeConsumed).join('');
    // 日锚点按 key 长度降序剥，「大后天」先于「后天」，否则残留「大」
    for (const k of dayoffKeysByLen()) rest = rest.split(k).join('');
    rest = rest.replace(new RegExp(REC_STRIP_SRC, 'g'), '');
    if (clk.todConsumed) rest = rest.split(clk.todConsumed).join('');
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
    // 查询类：必须含 闹钟/提醒 域词；查询词与宾语之间允许夹时间词组（「查看晚上8点的闹钟」），
    // 但限长 ≤12 字且不含句读，避免正文内容词误劫持建闹钟句
    // （历史 bug 51bb00e：提醒我看书 / 提醒我买几个苹果 / 背单词呢 必须是 create）
    const QUERY_VERB_RE = /(查看|查一下|列出|显示|看一下|看下|告诉我|有哪些|有什么)[^，。]{0,12}?(闹钟|提醒)/;
    const QUERY_DOMAIN_RE = /(闹钟|提醒)\s*(?:有哪些|有什么|列表|清单|有几个|多少个?|呢|在吗|都有)/;
    if (hasDomain && (QUERY_VERB_RE.test(text) || QUERY_DOMAIN_RE.test(text))) return { intent: 'query' };
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

  /**
   * 把 epoch 毫秒按 tz 拆成墙钟字段与带偏移的 ISO 串。
   * 创建路径与 match 路径共用这一套（不新造时区换算，全部走 scheduler）。
   * @param {number} epoch 毫秒
   * @param {string} tz IANA 时区
   * @return {{y:number, mo:number, d:number, hh:string, mm:string, iso:string}}
   */
  function isoFor(epoch, tz) {
    const tp = sched().tzDateParts(epoch, tz);                       // tz 下的日历日 {y,mo,d}
    const whm = sched().wallClockAt(epoch, tz).split(':');           // tz 下的墙钟 HH:MM
    const offMs = sched().tzOffsetAt(tz, epoch);
    const offMin = Math.round(offMs / 60000);
    const sign = offMin >= 0 ? '+' : '-';
    const oh = pad2(Math.floor(Math.abs(offMin) / 60));
    const om = pad2(Math.abs(offMin) % 60);
    // 秒数：wallClockAt 只到分钟，秒要从「epoch + 实际偏移」直接取，否则 ISO 串与 timestamp 自相矛盾
    // （相对时长类闹钟 now+30s 会落在 :30 秒，硬写 :00 会让 datetime 比 timestamp 早最多 59s）
    const ss = pad2(Math.floor((epoch + offMs) / 1000) % 60);
    return {
      y: tp.y, mo: tp.mo, d: tp.d, hh: whm[0], mm: whm[1], ss: ss,
      iso: `${tp.y}-${pad2(tp.mo)}-${pad2(tp.d)}T${whm[0]}:${whm[1]}:${ss}${sign}${oh}:${om}`
    };
  }

  /**
   * 给 match 条件补「下一次发生」的时间戳与候选集（取消/查询/修改三路径共用）。
   * 语义：basis = 'next_occurrence'；timestamp 为 Unix 秒（与 alarm.timestamp 同单位）。
   * 无 time 条件（或 match.all）时不猜，原样返回。
   * @param {Object} match extractMatch 的产物
   * @param {{tz:string, nowEpoch:number, todayTz:{y:number, mo:number, d:number}}} ctx 时区上下文
   * @return {Object} 同一个 match（已附加 timestamp/datetime/timezone/basis[/occurrences]）
   */
  function attachMatchTimestamp(match, ctx) {
    if (!match || !match.time) return match;
    const tz = ctx.tz;
    const nowEpoch = ctx.nowEpoch;
    let y, mo, d;
    if (match.date) {
      const p = String(match.date).split('-').map(Number);
      y = p[0]; mo = p[1]; d = p[2];
    } else {
      y = ctx.todayTz.y; mo = ctx.todayTz.mo; d = ctx.todayTz.d;
    }
    const hm = match.time.split(':').map(Number);
    let baseTs = sched().wallToEpoch(y, mo, d, hm[0], hm[1], tz);
    if (!match.date && baseTs < nowEpoch) {
      // 没给日期且今天这个点已过 → 顺延到明天（走 addDays 做日历算术，避免 +86400000 在 DST 下漂移）
      // 判定用严格小于：与 scheduler.computeNext 的 `while (t < now)` 对齐——「正好等于 now」算未过
      const nb = sched().addDays(y, mo, d, 1);
      baseTs = sched().wallToEpoch(nb.y, nb.mo, nb.d, hm[0], hm[1], tz);
    }
    const isRecurring = !!(match.recurrence && match.recurrence !== 'none');
    // 重复闹钟的「下一次发生」以 scheduler.computeNext 为准（唯一权威的重复规则引擎，不重写）
    let ts = baseTs;
    if (isRecurring) {
      const first = sched().computeNext(match.time, match.recurrence, baseTs, tz, nowEpoch);
      if (first != null) ts = first;
    }
    const info = isoFor(ts, tz);
    match.timestamp = Math.floor(ts / 1000);   // Unix 秒，与 create 路径 alarm.timestamp 一致
    match.datetime = info.iso;
    match.timezone = tz;
    match.basis = 'next_occurrence';
    // 候选集：重复闹钟才有多次发生，第 1 项与 timestamp 一致，后续继续用 computeNext 推进
    if (isRecurring) {
      const occ = [Math.floor(ts / 1000)];
      let cursor = ts + 1000;
      for (let i = 0; i < 2; i++) {
        const next = sched().computeNext(match.time, match.recurrence, baseTs, tz, cursor);
        if (next == null) break;
        occ.push(Math.floor(next / 1000));
        cursor = next + 1000;
      }
      match.occurrences = occ;
    }
    return match;
  }

  function parseAlarm(text, opts) {
    // 入参规范化：非字符串（number/object/array）不该让 .trim() 抛 TypeError
    text = (text === null || text === undefined) ? '' : String(text).trim();
    // ---- 0. 时区 / 基准时间（提到最前：cancel / query / modify 分支也要用，不能只在 create 分支求值） ----
    // 支持 opts.now 覆盖"当前时间"基准（开放 API 的确定性测试/回放）；默认取真实当前时间
    // tz：贯穿全函数的时区（P3）。默认上海；显式 opts.tz 优先（开放 API / 前端检测传入）。
    const tz = safeTz(opts && opts.tz);
    const nowEpoch = (opts && opts.now != null)
      ? (typeof opts.now === 'number' ? opts.now : new Date(opts.now).getTime())
      : Date.now();
    const now = new Date(nowEpoch);
    // 用户在 tz 下的"今天"日历日（跨时区基准，避免 UTC 容器下错位）。所有换算走 scheduler。
    const todayTz = sched().tzDateParts(nowEpoch, tz);
    const matchCtx = { tz: tz, nowEpoch: nowEpoch, todayTz: todayTz };

    // ---- 0.1 对话式意图识别（取消 / 修改 / 查询 / 新建） ----
    const intentRes = detectIntent(text);
    if (intentRes.intent === 'cancel') {
      return {
        success: true, intent: 'cancel', raw: text,
        match: attachMatchTimestamp(extractMatch(text, matchCtx), matchCtx),
        confidence: 0.9, needs_clarification: false, ambiguities: []
      };
    }
    if (intentRes.intent === 'query') {
      return {
        success: true, intent: 'query', raw: text,
        match: attachMatchTimestamp(extractMatch(text, matchCtx), matchCtx),
        confidence: 0.9, needs_clarification: false, ambiguities: []
      };
    }
    if (intentRes.intent === 'modify') {
      const match = attachMatchTimestamp(extractMatch(intentRes.oldSpec || '', matchCtx), matchCtx);
      const update = extractUpdate(intentRes.newSpec || '', matchCtx);
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
    if ((m = text.match(new RegExp(DAILY_SRC)))) { recurrence = 'daily'; consumed.push(m[0]); }
    else if ((m = text.match(/(工作日|周一到周五|星期一到星期五|礼拜一到礼拜五|周一到周五四)/))) { recurrence = 'weekdays'; consumed.push(m[0]); }
    else if ((m = text.match(/(周末|周六周日|星期六星期天|周六日)/))) { recurrence = 'weekend'; consumed.push(m[0]); }
    else if ((m = text.match(/每([零一二两三四五六七八九十百\d]+)天/))) { recurrence = 'every:' + cnNum(m[1]); consumed.push(m[0]); }
    else if ((m = text.match(/(隔|双)(周|星期|礼拜|个)([一二三四五六日天七\d])/))) { recurrence = 'biweekly:' + weekNum(m[3]); consumed.push(m[0]); }
    else if ((m = text.match(/(每周|每星期|每个礼拜)([一二三四五六日天七\d])/))) { recurrence = 'weekly:' + weekNum(m[2]); consumed.push(m[0]); }
    else if ((m = text.match(/(每个月|每月)(\d{1,2}|[一二两三四五六七八九十]{1,4})(号|日)/))) { recurrence = 'monthly:' + cnNum(m[2]); consumed.push(m[0]); }

    // ---- 2. 相对时间（复合时长求和；「天」级交给日期逻辑，避免把 6天后 当成 +6 天时长） ----
    let relMs = null;
    const relDur = matchRelDuration(text);
    if (relDur) { relMs = relDur.ms; consumed.push(relDur.consumed); }

    // ---- 3. 日锚点（含 今/明/后 + 早/晚/午 复合） ----
    let dayOffset = 0, dayAnchorConsumed = null;
    if ((m = text.match(/(大后天)/))) { dayOffset = 3; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(后天)/))) { dayOffset = 2; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(明天|明早|明晨|明晚|次日)/))) { dayOffset = 1; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(今天|今日|今早|今晨|今午|今晚|现在|此刻)/))) { dayOffset = 0; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(昨天|昨日)/))) { dayOffset = -1; dayAnchorConsumed = m[0]; }
    // 「大前天」必须排在「前天」之前：否则会被 前天 抢走，静默算成 -2 天（与「大后天」
    // 曾被「后天」抢走是同一类顺序缺口，见 Task5 修 2）。
    else if ((m = text.match(/(大前天|大前日)/))) { dayOffset = -3; dayAnchorConsumed = m[0]; }
    else if ((m = text.match(/(前天)/))) { dayOffset = -2; dayAnchorConsumed = m[0]; }
    let compoundTod = 0;
    if (dayAnchorConsumed && /晚/.test(dayAnchorConsumed)) compoundTod = 12;
    if (dayAnchorConsumed) consumed.push(dayAnchorConsumed);
    // ---- 3.5 「N天后」日期增量（是日期锚点，不是时长；「后天」已在 3 里优先处理） ----
    if (dayAnchorConsumed === null) {
      // 量化词有界：无界 `[一二两三四五六七八九十]+` 遇到 10k 中文数字串，
      // 每个起点都要回溯一遍（O(n²)，实测 235ms）；真实「N天」不会超过 4 个字。
      if ((m = text.match(/(\d{1,6}|[一二两三四五六七八九十]{1,4})\s*天\s*(?:之后|以后|后)/))) {
        const n = cnNum(m[1]);
        if (n !== null) { dayOffset = n; dayAnchorConsumed = m[0]; consumed.push(m[0]); }
      }
    }

    // ---- 4. 星期锚点（支持汉字与数字，如 下周6 / 周6 / 星期6 / 礼拜6） ----
    let weekTarget = null, weekNext = false;
    // 「下X」的前缀要能吃下三种组合：下周X / 下个周X / 下个星期X（下个星期六 曾落到裸写分支被算成本周）
    if ((m = text.match(/(下个?(?:周|星期|礼拜)|下个?)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = true; consumed.push(m[0]); }
    else if ((m = text.match(/(本个?|本星期|本礼拜|本周)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = false; consumed.push(m[0]); }
    else if ((m = text.match(/(周|星期|礼拜)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = false; consumed.push(m[0]); }

    // ---- 5+6. 时段词校正 + 时刻解析（统一走 resolveClock，与取消/查询/修改路径同源） ----
    const clk = resolveClock(text, compoundTod);
    const todAdd = clk.todAdd, todConsumed = clk.todConsumed, todNoon = clk.todNoon;
    if (todConsumed) consumed.push(todConsumed);
    const hour = clk.hour, minute = clk.minute, timeConsumed = clk.timeConsumed;
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
    // tz / now / nowEpoch / todayTz 已在函数顶部求值（cancel/query/modify 分支也要用）
    // 日期锚点同样跑在掩蔽文本上：「一日之计在于晨」不能因为含「一日」被当作 1 号
    const timeText = maskNonTime(text);
    // 被掩蔽的片段（量词点 / 副词点 / 超长数字 / 成语 / 人名词）不计入备注
    for (let i = 0; i < text.length; i++) {
      if (timeText[i] === MASK_CHAR && text[i] !== MASK_CHAR) {
        let j = i;
        while (j < text.length && timeText[j] === MASK_CHAR && text[j] !== MASK_CHAR) j++;
        consumed.push(text.slice(i, j));
        i = j - 1;
      }
    }
    // 节日/农历/节气：先让绝对日期优先（2025年10月10日 这类不走节日表）
    let absDate = parseAbsDate(timeText);
    let holidayError = null;
    if (!absDate) {
      const fest = parseHoliday(text, todayTz);
      if (fest && fest.outOfRange) {
        holidayError = '「' + fest.name + '」' + fest.year + ' 年的日期超出支持范围（'
          + FEST_YEAR_MIN + '–' + FEST_YEAR_MAX + '），请换个年份，或直接说公历日期（如「12月25日」）';
      } else if (fest) {
        absDate = { year: fest.year, month: fest.month, day: fest.day, consumed: fest.consumed };
      }
    }

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
      if (ctxHasDay && relMs !== null && hour === null) { contradiction = true; relMs = null; }
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
    // 绝对日期的年/月补全（未给年份/月份时按"已过期则顺延"），「有时刻」「缺时刻」两条路径共用
    const resolvedYmd = absDate ? resolveAbsYmd(absDate, todayTz) : null;
    const resolvedDateStr = resolvedYmd
      ? resolvedYmd.y + '-' + pad2(resolvedYmd.mo) + '-' + pad2(resolvedYmd.d) : null;

    // 「已解析出的公历日」——`date` 字段的唯一来源：绝对日期 / 星期锚点 / 日锚点 三条路径共用。
    // 契约：句子只给日期不给钟点时，date 也必须有值；但**不许**因此凭空编一个时刻
    // （缺钟点仍旧走澄清追问，time 保持为空）。
    // 相对时长（relMs）路径不在此列：它的日历日由触发时刻所在的 tz 日决定，
    // 不能拿句中的日锚点顶替（「明天10分钟后」的时刻可能在今天）。
    let anchorYmd = resolvedYmd;
    if (!anchorYmd && relMs === null) {
      if (weekTarget !== null) {
        anchorYmd = weekAnchorYmd(weekTarget, weekNext, todayTz);
      } else if (dayAnchorConsumed !== null || dayOffset !== 0) {
        anchorYmd = sched().addDays(todayTz.y, todayTz.mo, todayTz.d, dayOffset);
      }
    }
    const anchorDateStr = anchorYmd
      ? anchorYmd.y + '-' + pad2(anchorYmd.mo) + '-' + pad2(anchorYmd.d) : null;

    if (absDate) {
      consumed.push(absDate.consumed);
      if (hour === null) {
        target = null;
      } else {
        // hour 已由 resolveClock 做完时段校正，这里直接用于墙钟换算
        // 墙钟 → UTC：一律经 scheduler.wallToEpoch（按 tz 计算，含 DST 修正）
        target = new Date(sched().wallToEpoch(resolvedYmd.y, resolvedYmd.mo, resolvedYmd.d, hour, minute, tz));
        confidence = Math.max(confidence, 0.9);
      }
    } else if (relMs !== null) {
      // 复合时长已求和（2小时18分钟 = 138min），直接从 now 起算
      target = new Date(now.getTime() + relMs);
      confidence = 0.9;
    } else {
      // 以用户在 tz 下的"今天"为基准，所有日历日步进走 scheduler.addDays，避免与闹钟时区错位。
      // 星期锚点与日锚点的日历日已在上面算进 anchorYmd（与 `date` 字段共用同一结果）。
      let baseY = todayTz.y, baseM = todayTz.mo, baseD = todayTz.d;
      if (anchorYmd) { baseY = anchorYmd.y; baseM = anchorYmd.mo; baseD = anchorYmd.d; }
      if (hour === null) {
        target = null;
      } else {
        // hour 已由 resolveClock 做完时段校正，这里直接用于墙钟换算
        // 墙钟 → UTC：一律经 scheduler.wallToEpoch（按 tz 计算，含 DST 修正）
        target = new Date(sched().wallToEpoch(baseY, baseM, baseD, hour, minute, tz));
        confidence = 0.85;
        if (todConsumed) confidence += 0.05;
      }
    }

    // 节日年份越界：不猜日期，也不回落到「今天 + 时刻」
    if (holidayError) target = null;
    // 兜底护栏：任何路径算出的 Date 若不可表示（NaN），一律当「没算出来」走澄清，
    // 绝不让下游 tzDateParts/wallClockAt 抛 RangeError（那会变成一次 500）。
    if (target && !Number.isFinite(target.getTime())) target = null;

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
      if (holidayError) {
        // 节日年份超出支持范围：不猜日期，直接说清楚
        clarification = {
          type: 'out_of_range',
          question: holidayError,
          suggestions: [FEST_YEAR_MIN + '年春节', FEST_YEAR_MIN + '年中秋', '明天上午9点']
        };
      } else if (contradiction || hasDayAnchor) {
        const dayDesc = resolvedDateStr || describeDay({ weekTarget, weekNext, dayOffset, absDate, recurrence });
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
        // date：已解析出的公历日（绝对日期/节日/星期锚点/日锚点，即使缺钟点也有值，time 为空）
        date: anchorDateStr,
        confidence: Number(confidence.toFixed(2)),
        needs_clarification: true, ambiguities, clarification,
        partial: buildPartial({ recurrence, weekTarget, weekNext, dayOffset, absDate, leadMin, label })
      };
    }

    const pad = n => String(n).padStart(2, '0');
    // 时区墙钟与偏移一律来自 scheduler（不新造时区换算）：与 attachMatchTimestamp 共用 isoFor
    const info = isoFor(target.getTime(), tz);
    const tp = { y: info.y, mo: info.mo, d: info.d };
    const whm = [info.hh, info.mm];
    const iso = info.iso;

    return {
      success: true, raw: text, intent: 'create',
      // 已有 alarm 时，顶层 date 与 alarm.date 必须**是同一个值**（同口径，避免两个字段互相打架）：
      // 提前提醒把触发点挪过午夜时（明天0点提前10分钟 → 今天23:50），以实际落地的公历日为准。
      date: `${tp.y}-${pad(tp.mo)}-${pad(tp.d)}`,
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
