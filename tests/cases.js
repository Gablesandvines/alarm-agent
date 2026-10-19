/* ============================================================
 * tests/cases.js — 闹钟 Agent 解析引擎回归语料
 * 断言策略：用「相对校验」而非写死绝对时间，避免随时间失效。
 *   - time / recurrence：精确匹配（解析结果确定）
 *   - labelIncludes：label 中需包含的动作词（宽松，防停用词微调误报）
 *   - relSeconds：相对时间类（分钟后/小时后/秒后）期望的秒级偏移，容忍 ±5s
 *   - needsClarification：歧义/未识别用例
 * ============================================================ */
// 固定基准：2025-01-21T08:00:00Z = 上海 2025-01-21 16:00（用于相对时长/节日日期的确定性断言）
const NOW_A = Date.parse('2025-01-21T08:00:00Z');
// 固定基准：2026-08-01T00:00:00Z = 上海 2026-08-01 08:00（用于「当天」类节日修饰）
const NOW_B = Date.parse('2026-08-01T00:00:00Z');

module.exports = [
  // —— 日锚点 + 时段 ——
  { input: '明天早上8点叫我起床', expect: { success: true, time: '08:00', recurrence: 'none', labelIncludes: ['起床'] } },
  { input: '后天中午12点取快递', expect: { success: true, time: '12:00', recurrence: 'none', labelIncludes: ['取快递'] } },
  { input: '今晚8点看电影',       expect: { success: true, time: '20:00', recurrence: 'none', labelIncludes: ['看电影'] } },
  { input: '明晚9点吃夜宵',       expect: { success: true, time: '21:00', recurrence: 'none', labelIncludes: ['吃夜宵'] } },
  { input: '早上7点晨跑',         expect: { success: true, time: '07:00', recurrence: 'none', labelIncludes: ['晨跑'] } },
  { input: '下午3点开会',         expect: { success: true, time: '15:00', recurrence: 'none', labelIncludes: ['开会'] } },

  // —— 星期锚点 ——
  { input: '下周一9点半开会',     expect: { success: true, time: '09:30', recurrence: 'none', labelIncludes: ['开会'], dow: 1, nextWeek: true } },
  { input: '周一上午9点交报告',   expect: { success: true, time: '09:00', recurrence: 'none', labelIncludes: ['交报告'], dow: 1 } },
  { input: '下周六早上6点提醒我', expect: { success: true, time: '06:00', recurrence: 'none', dow: 6, nextWeek: true } },
  { input: '周六上午10点健身',    expect: { success: true, time: '10:00', recurrence: 'none', labelIncludes: ['健身'], dow: 6, nextWeek: false } },
  { input: '每周三下午3点健身',   expect: { success: true, time: '15:00', recurrence: 'weekly:3', labelIncludes: ['健身'] } },
  // —— 数字星期（用户反馈 Bug 回归）——
  { input: '下周6晚上6点提醒我',  expect: { success: true, time: '18:00', recurrence: 'none', dow: 6, nextWeek: true, labelExcludes: ['下周'] } },
  { input: '周6上午10点健身',     expect: { success: true, time: '10:00', recurrence: 'none', labelIncludes: ['健身'], dow: 6, nextWeek: false } },
  { input: '隔周6早上9点健身',    expect: { success: true, time: '09:00', recurrence: 'biweekly:6', labelIncludes: ['健身'], dow: 6 } },

  // —— 重复 ——
  { input: '每天晚上10点睡觉',    expect: { success: true, time: '22:00', recurrence: 'daily', labelIncludes: ['睡觉'] } },
  { input: '工作日早上7点半起床', expect: { success: true, time: '07:30', recurrence: 'weekdays', labelIncludes: ['起床'] } },
  { input: '周末上午10点逛街',    expect: { success: true, time: '10:00', recurrence: 'weekend', labelIncludes: ['逛街'] } },
  { input: '每月5号早上9点交房租', expect: { success: true, time: '09:00', recurrence: 'monthly:5', labelIncludes: ['交房租'] } },
  { input: '每个月15日下午3点还信用卡', expect: { success: true, time: '15:00', recurrence: 'monthly:15', labelIncludes: ['信用卡'] } },

  // —— 相对时间 ——
  { input: '30分钟后提醒我开会',  expect: { success: true, relSeconds: 30 * 60, labelIncludes: ['开会'] } },
  { input: '两小时后看锅',        expect: { success: true, relSeconds: 2 * 3600, labelIncludes: ['看锅'] } },
  { input: '半小时后吃药',        expect: { success: true, relSeconds: 30 * 60, labelIncludes: ['吃药'] } },
  { input: '10秒钟后测试一下',    expect: { success: true, relSeconds: 10, labelIncludes: ['测试'] } },

  // —— 歧义 / 未识别（多轮澄清：生成聚焦追问而非笼统报错） ——
  { input: '待会提醒我喝水',      expect: { success: false, needsClarification: true, clarifyType: 'time_anchor', hasSuggestions: true } },
  { input: '有空了叫我',          expect: { success: false, needsClarification: true, clarifyType: 'time_anchor', hasSuggestions: true } },
  { input: '稍后吃药',            expect: { success: false, needsClarification: true, clarifyType: 'time_anchor', hasSuggestions: true } },
  // —— 多轮合并（模拟 pendingRaw 累积后再整体解析）——
  { input: '待会提醒我喝水 30分钟后', expect: { success: true, relSeconds: 30 * 60, labelIncludes: ['喝水'] } },
  { input: '有空了叫我 1小时后',     expect: { success: true, relSeconds: 3600 } },

  // —— 绝对日期（用户反馈 Bug 回归）——
  { input: '2026年10月10日早上9点提醒我', expect: { success: true, dateFixed: '2026-10-10', time: '09:00', recurrence: 'none' } },
  { input: '2026-10-10 09:00 开会',       expect: { success: true, dateFixed: '2026-10-10', time: '09:00', recurrence: 'none', labelIncludes: ['开会'] } },
  { input: '10月1日早上8点看展',          expect: { success: true, time: '08:00', recurrence: 'none', future: true, labelIncludes: ['看展'] } },
  { input: '8号上午10点取药',             expect: { success: true, time: '10:00', recurrence: 'none', future: true, labelIncludes: ['取药'] } },

  // —— 新增：每X天 / 隔周 / 周一到周五 ——
  { input: '每3天早上8点吃药',   expect: { success: true, time: '08:00', recurrence: 'every:3', labelIncludes: ['吃药'] } },
  { input: '每三天晚上10点散步', expect: { success: true, time: '22:00', recurrence: 'every:3', labelIncludes: ['散步'] } },
  { input: '隔周六早上9点健身',   expect: { success: true, time: '09:00', recurrence: 'biweekly:6', labelIncludes: ['健身'] } },
  { input: '双周一上午9点开会',   expect: { success: true, time: '09:00', recurrence: 'biweekly:1', labelIncludes: ['开会'] } },
  { input: '周一到周五早上9点打卡', expect: { success: true, time: '09:00', recurrence: 'weekdays', labelIncludes: ['打卡'] } },

  // —— 新增：提前提醒（lead） ——
  { input: '提前10分钟提醒我晚上8点开会', expect: { success: true, time: '19:50', recurrence: 'none', lead: 10, labelIncludes: ['开会'] } },
  { input: '提前半小时提醒我晚上9点吃药', expect: { success: true, time: '20:30', recurrence: 'none', lead: 30, labelIncludes: ['吃药'] } },

  // —— 新增：节假日（阳历固定 + 农历近年份） ——
  { input: '元旦早上9点看升旗',   expect: { success: true, time: '09:00', recurrence: 'none', nextOccurrenceMD: [1, 1], labelIncludes: ['升旗'] } },
  { input: '国庆早上8点出游',     expect: { success: true, time: '08:00', recurrence: 'none', nextOccurrenceMD: [10, 1], labelIncludes: ['出游'] } },
  { input: '劳动节下午3点休息',   expect: { success: true, time: '15:00', recurrence: 'none', nextOccurrenceMD: [5, 1], labelIncludes: ['休息'] } },
  { input: '儿童节早上9点',       expect: { success: true, time: '09:00', recurrence: 'none', nextOccurrenceMD: [6, 1] } },
  { input: '春节早上8点拜年',     expect: { success: true, time: '08:00', recurrence: 'none', future: true, labelIncludes: ['拜年'] } },
  { input: '端午节早上10点',      expect: { success: true, time: '10:00', recurrence: 'none', future: true } },
  { input: '中秋早上8点赏月',     expect: { success: true, time: '08:00', recurrence: 'none', future: true, labelIncludes: ['赏月'] } },

  // —— 新增：其它时刻 / 锚点覆盖 ——
  { input: '大后天早上8点出发',   expect: { success: true, time: '08:00', recurrence: 'none', future: true, labelIncludes: ['出发'] } },
  { input: '中午12点吃饭',        expect: { success: true, time: '12:00', recurrence: 'none', labelIncludes: ['吃饭'] } },
  { input: '零点准时抢',          expect: { success: true, time: '00:00', recurrence: 'none', labelIncludes: ['抢'] } },
  { input: '23点睡觉',            expect: { success: true, time: '23:00', recurrence: 'none', labelIncludes: ['睡觉'] } },
  { input: '12点半午休',          expect: { success: true, time: '12:30', recurrence: 'none', labelIncludes: ['午休'] } },
  { input: '下午3点半开会',       expect: { success: true, time: '15:30', recurrence: 'none', labelIncludes: ['开会'] } },
  { input: '1小时后关火',         expect: { success: true, relSeconds: 3600, labelIncludes: ['关火'] } },
  { input: '一个小时后取快递',    expect: { success: true, relSeconds: 3600, labelIncludes: ['取快递'] } },
  { input: '明天晚上11点泡脚',    expect: { success: true, time: '23:00', recurrence: 'none', labelIncludes: ['泡脚'] } },
  { input: '每周一上午9点开会',   expect: { success: true, time: '09:00', recurrence: 'weekly:1', labelIncludes: ['开会'] } },
  { input: '前天约饭',            expect: { success: false, needsClarification: true } },
  { input: '昨天下午开会',        expect: { success: false, needsClarification: true } },

  // —— 多轮澄清（context 结构化合并，修复"下周一"丢上下文）——
  // 首轮：有日期锚点但缺时刻 → 聚焦"几点"，并保留 partial
  { input: '下周一提醒我',        expect: { success: false, needsClarification: true, clarifyType: 'time_of_day', partialWeekTarget: 1 } },
  { input: '10月10日提醒我',      expect: { success: false, needsClarification: true, clarifyType: 'time_of_day', partialAbsDateMD: [10, 10] } },
  // 次轮：只补"下午3点" → 与 partial(下周一) 合并，不丢日期
  { input: '下午3点', context: { weekTarget: 1, weekNext: true }, expect: { success: true, time: '15:00', recurrence: 'none', dow: 1, nextWeek: true } },
  { input: '晚上8点', context: { dayOffset: 1 }, expect: { success: true, time: '20:00', recurrence: 'none', future: true } },
  { input: '上午9点', context: { absDate: { year: 2026, month: 10, day: 10 } }, expect: { success: true, dateFixed: '2026-10-10', time: '09:00', recurrence: 'none' } },
  { input: '下午3点', context: { recurrence: 'weekly:3', weekTarget: 3 }, expect: { success: true, time: '15:00', recurrence: 'weekly:3' } },
  // 矛盾检测：已有日期锚点却只给"相对时长" → 不静默丢弃日期，仍追问具体时刻，partial 保留
  { input: '30分钟', context: { weekTarget: 1, weekNext: true }, expect: { success: false, needsClarification: true, clarifyType: 'time_of_day', partialWeekTarget: 1 } },
  { input: '30分钟后', context: { weekTarget: 1, weekNext: true }, expect: { success: false, needsClarification: true, clarifyType: 'time_of_day', partialWeekTarget: 1 } },

  // —— 对话式意图：取消 / 修改 / 查询（P0 产品力）——
  { input: '取消8点的闹钟',     expect: { success: true, intent: 'cancel', matchTime: '08:00' } },
  { input: '删除所有闹钟',       expect: { success: true, intent: 'cancel', matchAll: true } },
  { input: '取消明天的闹钟',     expect: { success: true, intent: 'cancel', hasDate: true } },
  { input: '取消每天早上的闹钟', expect: { success: true, intent: 'cancel', matchRecurrence: 'daily' } },
  { input: '把起床的闹钟改成7点', expect: { success: true, intent: 'modify', matchLabel: '起床', updateTime: '07:00' } },
  { input: '改成每天',           expect: { success: true, intent: 'modify', updateRecurrence: 'daily' } },
  { input: '把8点改成9点',       expect: { success: true, intent: 'modify', matchTime: '08:00', updateTime: '09:00' } },
  { input: '改成',               expect: { success: false, intent: 'modify', clarifyType: 'modify_target' } },
  { input: '我有哪些闹钟',       expect: { success: true, intent: 'query' } },
  { input: '显示我的闹钟',       expect: { success: true, intent: 'query' } },
  // 不应误判为意图（回归：普通建闹钟句即使含"取消"语义词也不应误触发）
  { input: '明天早上8点叫我起床', expect: { success: true, intent: 'create' } },
  { input: '30分钟后提醒我开会',  expect: { success: true, intent: 'create' } },

  // —— I3 回归：查询意图锚定闹钟宾语，正文内容词（看/几个/呢/都有）不得误判为 query ——
  { input: '每天下午14点10分提醒我看书', expect: { success: true, intent: 'create', time: '14:10', recurrence: 'daily', labelIncludes: ['看书'] } },
  { input: '每天下午3点提醒我看电影',    expect: { success: true, intent: 'create', time: '15:00', recurrence: 'daily' } },
  { input: '每天下午3点提醒我去看医生',  expect: { success: true, intent: 'create', time: '15:00', recurrence: 'daily' } },
  { input: '明天提醒我买几个苹果',       expect: { intent: 'create' } },
  { input: '每天提醒我背单词呢',         expect: { intent: 'create' } },
  { input: '明天提醒我都有哪些作业要交', expect: { intent: 'create' } },
  // 真实查询仍须判 query（查询词紧贴 闹钟/提醒 宾语）
  { input: '查看闹钟',       expect: { success: true, intent: 'query' } },
  { input: '看一下我的闹钟', expect: { success: true, intent: 'query' } },
  { input: '闹钟列表',       expect: { success: true, intent: 'query' } },
  { input: '闹钟呢',         expect: { success: true, intent: 'query' } },

  // —— 重复终止条件（P1 产品力）：到某天为止 / 持续N天 / 共N次 ——
  // date 型：到指定日期为止（含当天仍可触发），且结束日期不污染闹钟自身锚点
  { input: '每天8点跑步，到2027年6月1日为止', expect: { success: true, time: '08:00', recurrence: 'daily', endType: 'date', endDate: '2027-06-01', labelIncludes: ['跑步'] } },
  { input: '每周三下午3点健身，到2026年12月31日为止', expect: { success: true, time: '15:00', recurrence: 'weekly:3', endType: 'date', endDate: '2026-12-31', labelIncludes: ['健身'] } },
  // days 型：持续 N 天
  { input: '每天8点吃药，持续15天', expect: { success: true, time: '08:00', recurrence: 'daily', endType: 'days', endDays: 15, labelIncludes: ['吃药'] } },
  // count 型：共 N 次（中文数字 + 阿拉伯数字）
  { input: '每周一9点开会，共10次', expect: { success: true, time: '09:00', recurrence: 'weekly:1', endType: 'count', endCount: 10, labelIncludes: ['开会'] } },
  { input: '工作日早上8点吃药，响5次就停', expect: { success: true, time: '08:00', recurrence: 'weekdays', endType: 'count', endCount: 5, labelIncludes: ['吃药'] } },
  // 单次闹钟忽略结束条件（无重复则 end 不挂载）
  { input: '明天8点开会，共5次', expect: { success: true, time: '08:00', recurrence: 'none', endNull: true, future: true } },

  // —— 时区真正可用化（P0/P1）：tz 透传 + 墙钟不漂移 ——
  // 同一句"明天早上8点"，在纽约与上海都应得到 08:00 墙钟，且 timezone 字段正确、datetime 偏移符合 IANA
  { input: '明天早上8点叫我起床', tz: 'America/New_York', expect: { success: true, time: '08:00', timezone: 'America/New_York', recurrence: 'none', labelIncludes: ['起床'] } },
  { input: '明天早上8点叫我起床', tz: 'Asia/Shanghai', expect: { success: true, time: '08:00', timezone: 'Asia/Shanghai', recurrence: 'none', labelIncludes: ['起床'] } },
  { input: '每周三下午3点健身', tz: 'Europe/London', expect: { success: true, time: '15:00', timezone: 'Europe/London', recurrence: 'weekly:3', labelIncludes: ['健身'] } },
  { input: '30分钟后提醒我开会', tz: 'America/Los_Angeles', expect: { success: true, relSeconds: 30 * 60, timezone: 'America/Los_Angeles', labelIncludes: ['开会'] } },

  // ============================================================
  // 借鉴 fst-time-nlu（Apache-2.0）的第一阶段能力回归
  // ============================================================

  // —— P0 误报过滤（量词「点」：点 = 「项/条」而非时刻）——
  // 这些句子里的数词 + 点表示"条数"，绝不能解析成 02:00 / 03:00 / 01:00
  { input: '再说两点',   expect: { success: false, needsClarification: true } },
  { input: '讲三点意见', expect: { success: false, needsClarification: true } },
  { input: '有两点建议', expect: { success: false, needsClarification: true } },
  { input: '提几点想法', expect: { success: false, needsClarification: true } },
  { input: '补充一点',   expect: { success: false, needsClarification: true } },

  // —— P0 误报过滤（副词「一点/半点」：程度副词，不是 1 点）——
  { input: '快一点',   expect: { success: false, needsClarification: true } },
  { input: '早一点',   expect: { success: false, needsClarification: true } },
  { input: '慢一点',   expect: { success: false, needsClarification: true } },
  { input: '一点点',   expect: { success: false, needsClarification: true } },
  { input: '有一点',   expect: { success: false, needsClarification: true } },
  { input: '多一点',   expect: { success: false, needsClarification: true } },
  { input: '少一点',   expect: { success: false, needsClarification: true } },

  // —— P0 误报过滤（超长数字串：手机号/身份证/卡号）——
  { input: '身份证45901199001011234', expect: { success: false, needsClarification: true } },

  // —— P0 误报过滤（成语 / 人名词：「一日」不是 1 号，「黎明」不是拂晓）——
  { input: '一日之计在于晨',   expect: { success: false, needsClarification: true } },
  { input: '黎明主演的电影',   expect: { success: false, needsClarification: true } },

  // —— P0 无害性：合法时刻不得被过滤规则误杀 ——
  { input: '两点开会',     expect: { success: true, time: '02:00', recurrence: 'none', labelIncludes: ['开会'] } },
  { input: '下午两点',     expect: { success: true, time: '14:00', recurrence: 'none' } },
  { input: '十一点提醒我', expect: { success: true, time: '11:00', recurrence: 'none' } },
  { input: '一点钟',       expect: { success: true, time: '01:00', recurrence: 'none' } },
  // 量词点与真实时刻同句时，只滤掉量词、保留真实时刻
  { input: '讲两点意见，下午三点开会', expect: { success: true, time: '15:00', recurrence: 'none', labelIncludes: ['开会'] } },

  // —— 中文数字细节修复（「X点Y刻」曾被吃成 X:0Y）——
  { input: '3点1刻',            expect: { success: true, time: '03:15', recurrence: 'none' } },
  { input: '提醒我三点一刻开会',  expect: { success: true, time: '03:15', recurrence: 'none', labelIncludes: ['开会'] } },
  { input: '3点三刻',           expect: { success: true, time: '03:45', recurrence: 'none' } },
  { input: '三点三刻',          expect: { success: true, time: '03:45', recurrence: 'none' } },
  { input: '三点半',            expect: { success: true, time: '03:30', recurrence: 'none' } },
  { input: '三点两刻',          expect: { success: true, time: '03:30', recurrence: 'none' } },
  // 中文分钟数（十及以上）此前会被丢成 X:00
  { input: '三点十五分',         expect: { success: true, time: '03:15', recurrence: 'none' } },
  // 中文两位数小时（十一/十二/二十三）此前会被截成个位
  { input: '十二点',            expect: { success: true, time: '12:00', recurrence: 'none' } },
  { input: '二十三点睡觉',       expect: { success: true, time: '23:00', recurrence: 'none', labelIncludes: ['睡觉'] } },
  { input: '每天下午三点一刻开会', expect: { success: true, time: '15:15', recurrence: 'daily', labelIncludes: ['开会'] } },

  // ============================================================
  // 第二阶段 2a：复合相对时长 + 中午校正（评测挖出的真 bug）
  // 基准固定为上海 2025-01-21 16:00，全部可确定性断言
  // ============================================================

  // —— 复合时长求和（此前只取最后一段：2小时18分钟 被算成 +18min）——
  { input: '2小时18分钟以后提醒我', now: NOW_A, expect: { success: true, time: '18:18', dateFixed: '2025-01-21', recurrence: 'none' } },
  { input: '1小时30分钟后',        now: NOW_A, expect: { success: true, time: '17:30', dateFixed: '2025-01-21', recurrence: 'none' } },
  // 「一个半小时」= 90min（此前被算成 +30min）
  { input: '一个半小时后叫我',      now: NOW_A, expect: { success: true, time: '17:30', recurrence: 'none' } },
  // 「N个半小时」= N×60+30
  { input: '两个半小时后',          now: NOW_A, expect: { success: true, time: '18:30', recurrence: 'none' } },
  // 「再过X」无「后」也识别为时长（此前 time 为空）
  { input: '再过十分钟叫我',        now: NOW_A, expect: { success: true, time: '16:10', recurrence: 'none' } },
  { input: '再过10分钟叫我',        now: NOW_A, expect: { success: true, time: '16:10', recurrence: 'none' } },
  { input: '再过5分钟',             now: NOW_A, expect: { success: true, time: '16:05', recurrence: 'none' } },
  // 「X内」也按时长处理；半天 = 12h
  { input: '10分钟内提醒我',        now: NOW_A, expect: { success: true, time: '16:10', recurrence: 'none' } },
  { input: '半天后叫我',            now: NOW_A, expect: { success: true, time: '04:00', dateFixed: '2025-01-22', recurrence: 'none' } },

  // —— 反例：日期增量不得被当时长 ——
  // 「6天后3点」= 2025-01-27 03:00（此前被当成今天 03:00，且不能变成 +6 天时长）
  { input: '6天后3点',              now: NOW_A, expect: { success: true, time: '03:00', dateFixed: '2025-01-27', recurrence: 'none' } },
  // 无「后」的裸时长不构成时刻（也不能被当作「一点」）
  { input: '一个半小时',            now: NOW_A, expect: { success: false, needsClarification: true } },
  { input: '半小时',                now: NOW_A, expect: { success: false, needsClarification: true } },

  // —— 中午校正：中午 1~3 点 → +12；11/12 点保持 ——
  { input: '中午一点',   now: NOW_A, expect: { success: true, time: '13:00', recurrence: 'none' } },
  { input: '中午两点',   now: NOW_A, expect: { success: true, time: '14:00', recurrence: 'none' } },
  { input: '中午三点',   now: NOW_A, expect: { success: true, time: '15:00', recurrence: 'none' } },
  { input: '中午十二点', now: NOW_A, expect: { success: true, time: '12:00', recurrence: 'none' } },
  { input: '中午十一点', now: NOW_A, expect: { success: true, time: '11:00', recurrence: 'none' } },
  { input: '中午12点半', now: NOW_A, expect: { success: true, time: '12:30', recurrence: 'none' } },
  // 其它时段词语义不得被改动
  { input: '凌晨一点',   now: NOW_A, expect: { success: true, time: '01:00', recurrence: 'none' } },
  { input: '下午一点',   now: NOW_A, expect: { success: true, time: '13:00', recurrence: 'none' } },
  { input: '晚上一点',   now: NOW_A, expect: { success: true, time: '13:00', recurrence: 'none' } },

  // ============================================================
  // 第二阶段 2b：节日 / 农历 / 节气（零依赖，2024–2035）
  // 仅给节日不给时刻时：time 为空、date 必须正确（dateResolved 断言）
  // ============================================================

  // —— 验收批次（team-lead 指定的 9 条已知日期） ——
  { input: '2025年春节',   now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2025-01-29' } },
  { input: '2025年中秋节', now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2025-10-06' } },
  { input: '2024年春节',   now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2024-02-10' } },
  { input: '明年春节',     now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2026-02-17' } },
  { input: '2025年母亲节', now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2025-05-11' } },
  { input: '2025年父亲节', now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2025-06-15' } },
  { input: '2025年冬至',   now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2025-12-21' } },
  { input: '2025年清明',   now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2025-04-04' } },
  { input: '2025年端午节', now: NOW_A, expect: { success: false, needsClarification: true, dateResolved: '2025-05-31' } },

  // —— 其余农历节日 ——
  { input: '2025年元宵节', now: NOW_A, expect: { dateResolved: '2025-02-12' } },
  { input: '2025年重阳节', now: NOW_A, expect: { dateResolved: '2025-10-29' } },
  { input: '2025年除夕',   now: NOW_A, expect: { dateResolved: '2025-01-28' } },
  { input: '2026年除夕',   now: NOW_A, expect: { dateResolved: '2026-02-16' } },
  { input: '2033年春节',   now: NOW_A, expect: { dateResolved: '2033-01-31' } },
  // —— 公历固定节日 / 星期推算节日 ——
  { input: '2025年情人节',   now: NOW_A, expect: { dateResolved: '2025-02-14' } },
  { input: '2025年圣诞节',   now: NOW_A, expect: { dateResolved: '2025-12-25' } },
  { input: '2025年感恩节',   now: NOW_A, expect: { dateResolved: '2025-11-27' } },
  { input: '2026年母亲节',   now: NOW_A, expect: { dateResolved: '2026-05-10' } },
  // —— 节日 + 时刻：date/time 同时正确 ——
  { input: '2025年春节早上8点拜年', now: NOW_A, expect: { success: true, time: '08:00', dateFixed: '2025-01-29', labelIncludes: ['拜年'] } },
  { input: '2025年中秋晚上8点赏月', now: NOW_A, expect: { success: true, time: '20:00', dateFixed: '2025-10-06', labelIncludes: ['赏月'] } },
  { input: '2025年冬至早上7点吃饺子', now: NOW_A, expect: { success: true, time: '07:00', dateFixed: '2025-12-21', labelIncludes: ['饺子'] } },
  // —— 修饰：前一天 / 当天 ——
  { input: '2025年春节前一天', now: NOW_A, expect: { dateResolved: '2025-01-28' } },
  { input: '春节前一天',       now: NOW_A, expect: { dateResolved: '2025-01-28' } },
  { input: '中秋当天',         now: NOW_B, expect: { dateResolved: '2026-09-25' } },
  { input: '冬至那天',         now: NOW_B, expect: { dateResolved: '2026-12-22' } },
  { input: '春节当天早上6点',   now: NOW_A, expect: { success: true, time: '06:00', dateFixed: '2025-01-29' } },
  // —— 不带年份：自动取最近一次未过期 ——
  { input: '春节早上8点拜年', now: NOW_A, expect: { success: true, time: '08:00', dateFixed: '2025-01-29' } },
  // —— 超出覆盖年份：不猜，明确提示 ——
  { input: '2040年春节', now: NOW_A, expect: { success: false, needsClarification: true, clarifyType: 'out_of_range', dateResolved: null } },
  { input: '2023年春节', now: NOW_A, expect: { success: false, needsClarification: true, clarifyType: 'out_of_range', dateResolved: null } },

  // ============================================================
  // 遗留 1：无分隔钟点（0900 / 1830 / 830 / 930）
  // 必须有上下文锚点（前 8 字内的时间语境词），且避开年份/金额/数量
  // ============================================================

  // —— 正例：4 位 HHMM ——
  { input: '明天早上0900提醒我', now: NOW_A, expect: { success: true, time: '09:00', dateFixed: '2025-01-22' } },
  { input: '明天早上0930提醒我', now: NOW_A, expect: { success: true, time: '09:30', dateFixed: '2025-01-22' } },
  { input: '明天1230吃饭',       now: NOW_A, expect: { success: true, time: '12:30', dateFixed: '2025-01-22', labelIncludes: ['吃饭'] } },
  { input: '明天1830下班',       now: NOW_A, expect: { success: true, time: '18:30', dateFixed: '2025-01-22', labelIncludes: ['下班'] } },
  // —— 正例：3 位 HMM ——
  { input: '明天早上930提醒我',  now: NOW_A, expect: { success: true, time: '09:30', dateFixed: '2025-01-22' } },
  { input: '明天130提醒我',      now: NOW_A, expect: { success: true, time: '01:30', dateFixed: '2025-01-22' } },
  // 日期锚点 + 无分隔钟点（「号」提供锚点，2018 是年份不是时刻）
  { input: '2018年7月19号830开会', now: NOW_A, expect: { success: true, time: '08:30', dateFixed: '2018-07-19', labelIncludes: ['开会'] } },
  // —— 时段校正照常生效 ——
  { input: '下午830提醒我', now: NOW_A, expect: { success: true, time: '20:30', dateFixed: '2025-01-21' } },
  { input: '晚上930提醒我', now: NOW_A, expect: { success: true, time: '21:30', dateFixed: '2025-01-21' } },

  // —— 反例：不能误判成时刻 ——
  // 4 位落在 1900–2099 → 年份
  { input: '2015年提醒我', now: NOW_A, expect: { success: false, needsClarification: true } },
  // 后接量词 → 金额/数量
  { input: '价格1830元',   now: NOW_A, expect: { success: false, needsClarification: true } },
  { input: '830万',        now: NOW_A, expect: { success: false, needsClarification: true } },
  // 无上下文锚点
  { input: '第830名',      now: NOW_A, expect: { success: false, needsClarification: true } },
  // 小时越界（24xx 不识别）
  { input: '明天2400提醒我', now: NOW_A, expect: { success: false, needsClarification: true } },
];
