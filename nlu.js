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
    if ((m = src.match(CLOCK_RE))) {
      const h = cnNum(m[1]);
      if (h === null) return null;
      // 小时超出 0..24 不是钟点（「27点」多为序号/温度），直接判为未识别
      if (h < 0 || h > 24) return null;
      return { hour: (h === 24 ? 0 : h), minute: parseMinuteTail(m[2]), consumed: m[0] };
    }
    return null;
  }

  // 从文本中抽取一个时刻（与 create 路径同源：统一走 matchClock，避免两处正则漂移）
  function matchTime(t) {
    const c = matchClock(t);
    return c ? (pad2(c.hour) + ':' + pad2(c.minute)) : null;
  }

  /* ---------------- 复合相对时长（P1） ----------------
   * 只处理「秒 / 分钟 / 小时」量级；「天及更大」一律交给日期增量逻辑（6天后3点 是日期，不是时长）。
   * 支持：半小时=30min、一个半小时=90min、N个半小时=N×60+30、半天=12h、中文数字、多段相加
   * （2小时18分钟 = 138min）。 */
  const DUR_NUM_SRC = '(?:\\d+|[一二两三四五六七八九十]+)';
  const DUR_SEG_SRC = [
    DUR_NUM_SRC + '个半(?:小时|钟头)',   // 一个半小时 = 90min / 两个半小时 = 150min
    '半个?(?:小时|钟头)',                // 半小时 = 30min
    '半天',                              // 半天 = 12h
    DUR_NUM_SRC + '个?(?:小时|钟头)',
    DUR_NUM_SRC + '(?:分钟|分)',
    DUR_NUM_SRC + '(?:秒钟|秒)'
  ].join('|');
  const DUR_RUN_SRC = '(?:' + DUR_SEG_SRC + ')+';
  const DUR_PRE_SRC = '(?:再过|过了|经过)';
  const DUR_SUF_SRC = '(?:之后|以后|之内|以内|后|内)';

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
    return (rest.length || !total) ? null : total;
  }

  /**
   * 从文本中识别相对时长表达式。
   * 两种形态：①「X + 后/以后/之后/内」（10分钟后、10分钟内）②「再过/过了/经过 + X」（再过十分钟叫我）。
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
    rest = rest.replace(/(\d{1,2})[:：]\d{1,2}/g, '').replace(CLOCK_RE_ALL, '');
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
    rest = rest.replace(/(\d{1,2})[:：]\d{1,2}/g, '').replace(CLOCK_RE_ALL, '');
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
    // 查询类：必须含 闹钟/提醒 域词，且查询词须锚定在「闹钟/提醒」宾语附近
    // （避免正文内容词「看/几个/多少/呢/都有」误劫持建闹钟句，如「提醒我看书/买几个苹果/背单词呢」）
    const QUERY_VERB_RE = /(查看|查一下|列出|显示|看一下|看下|告诉我|有哪些|有什么)\s*(?:的|我的)?\s*(闹钟|提醒)/;
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
    else if ((m = text.match(/(前天)/))) { dayOffset = -2; dayAnchorConsumed = m[0]; }
    let compoundTod = 0;
    if (dayAnchorConsumed && /晚/.test(dayAnchorConsumed)) compoundTod = 12;
    if (dayAnchorConsumed) consumed.push(dayAnchorConsumed);
    // ---- 3.5 「N天后」日期增量（是日期锚点，不是时长；「后天」已在 3 里优先处理） ----
    if (dayAnchorConsumed === null) {
      if ((m = text.match(/(\d+|[一二两三四五六七八九十]+)\s*天\s*(?:之后|以后|后)/))) {
        const n = cnNum(m[1]);
        if (n !== null) { dayOffset = n; dayAnchorConsumed = m[0]; consumed.push(m[0]); }
      }
    }

    // ---- 4. 星期锚点（支持汉字与数字，如 下周6 / 周6 / 星期6 / 礼拜6） ----
    let weekTarget = null, weekNext = false;
    if ((m = text.match(/(下个?|下星期|下礼拜|下周)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = true; consumed.push(m[0]); }
    else if ((m = text.match(/(本个?|本星期|本礼拜|本周)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = false; consumed.push(m[0]); }
    else if ((m = text.match(/(周|星期|礼拜)([一二三四五六日天七\d])/))) { weekTarget = weekNum(m[2]); weekNext = false; consumed.push(m[0]); }

    // ---- 5. 时段词（校正小时） ----
    let todAdd = compoundTod, todConsumed = null, todNoon = false;
    if (todAdd === 0) {
      if ((m = text.match(/(凌晨|拂晓)/))) { todAdd = 0; todConsumed = m[0]; }
      else if ((m = text.match(/(早上|早晨|上午|清早)/))) { todAdd = 0; todConsumed = m[0]; }
      else if ((m = text.match(/(中午|正午)/))) { todAdd = 0; todConsumed = m[0]; todNoon = true; }
      else if ((m = text.match(/(下午|傍晚|黄昏)/))) { todAdd = 12; todConsumed = m[0]; }
      else if ((m = text.match(/(晚上|夜里|夜晚|深夜)/))) { todAdd = 12; todConsumed = m[0]; }
      else if ((m = text.match(/(晚|夜)/))) { todAdd = 12; todConsumed = m[0]; }
      if (todConsumed) consumed.push(todConsumed);
    }

    // ---- 6. 时刻解析（P0：先掩蔽「两点意见 / 快一点 / 身份证…」等非时刻词，再统一解析） ----
    let hour = null, minute = 0, timeConsumed = null;
    const clock = matchClock(text);
    if (clock) { hour = clock.hour; minute = clock.minute; timeConsumed = clock.consumed; }
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
    let absDate = parseAbsDate(timeText) || parseHoliday(text, now);

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
        const h = correctHour(hour, todAdd, todConsumed, todNoon);
        // 墙钟 → UTC：一律经 scheduler.wallToEpoch（按 tz 计算，含 DST 修正）
        target = new Date(sched().wallToEpoch(year, month, day, h, minute, tz));
        confidence = Math.max(confidence, 0.9);
      }
    } else if (relMs !== null) {
      // 复合时长已求和（2小时18分钟 = 138min），直接从 now 起算
      target = new Date(now.getTime() + relMs);
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
        const h = correctHour(hour, todAdd, todConsumed, todNoon);
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
