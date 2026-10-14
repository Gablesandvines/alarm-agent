'use strict';
/*
 * tests/scheduler.js — 调度/时区纯函数回归
 * 覆盖：
 *   - 夏令时安全：美东 2026-03-08 春进、2026-11-01 秋退，墙钟 HH:MM 不漂移
 *   - nextTriggerMs：一次性（date+time）按闹钟时区换算
 *   - 重复重排：daily / monthly:N 给出未来触发且墙钟正确
 */
const { nextTriggerMs, computeNext, wallClockAt } = require('../scheduler.js');

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

// 把 epoch 在指定时区换算为本地日 YYYY-MM-DD（用于断言「下一天/下个月」）
function wallDateAt(epoch, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(epoch)); // YYYY-MM-DD
}

console.log('— 调度/时区回归 —');

// 1) 夏令时安全（确定性：用显式 date+time 直接走 wallToEpoch 的 DST 二次校正，不依赖真实时钟）
{
  const tz = 'America/New_York';
  // 春进 2026-03-08：02:00→03:00（当天 02:30 不存在）。09:00 应落在 EDT(UTC-4)
  const spr = nextTriggerMs({ date: '2026-03-08', time: '09:00', recurrence: 'none', timezone: tz });
  assert(wallClockAt(spr, tz) === '09:00', 'DST 春进：2026-03-08 09:00 墙钟正确', wallClockAt(spr, tz));
  assert(wallDateAt(spr, tz) === '2026-03-08', 'DST 春进：日期正确 2026-03-08', wallDateAt(spr, tz));
  // 秋退 2026-11-01：02:00→01:00（当天 01:30 出现两次）。09:00 应落在 EST(UTC-5)
  const fal = nextTriggerMs({ date: '2026-11-01', time: '09:00', recurrence: 'none', timezone: tz });
  assert(wallClockAt(fal, tz) === '09:00', 'DST 秋退：2026-11-01 09:00 墙钟正确', wallClockAt(fal, tz));
  assert(wallDateAt(fal, tz) === '2026-11-01', 'DST 秋退：日期正确 2026-11-01', wallDateAt(fal, tz));
  // 对照：非 DST 切换日的常规换算（美东标准时）墙钟同样正确
  const std = nextTriggerMs({ date: '2026-01-15', time: '09:00', recurrence: 'none', timezone: tz });
  assert(wallClockAt(std, tz) === '09:00' && wallDateAt(std, tz) === '2026-01-15', '常规日墙钟=09:00 且日期正确', wallClockAt(std, tz));
}

// 2) nextTriggerMs 一次性：date+time 按闹钟时区换算，墙钟/日期一致（用远未来日期，避免依赖运行时钟）
{
  const tz = 'America/Los_Angeles';
  const t = nextTriggerMs({ date: '2030-06-15', time: '14:30', recurrence: 'none', timezone: tz });
  assert(typeof t === 'number' && t > Date.now(), '一次性(LA 时区) 给出未来触发', String(t));
  assert(wallClockAt(t, tz) === '14:30', '一次性墙钟=14:30（与输入一致）', wallClockAt(t, tz));
  assert(wallDateAt(t, tz) === '2030-06-15', '一次性日期=2030-06-15', wallDateAt(t, tz));
}

// 3) monthly:N 重排：每月 5 号 09:00，应给出下一个 5 号（不早于 now）
{
  const tz = 'Asia/Shanghai';
  const now = Date.now();
  const t = computeNext('09:00', 'monthly:5', now, tz);
  assert(typeof t === 'number' && t > now, 'monthly:5 给出未来触发', String(t));
  const d = new Date(wallDateAt(t, tz) + 'T00:00:00');
  assert(d.getDate() === 5, 'monthly:5 触发日=每月 5 号', wallDateAt(t, tz));
  assert(wallClockAt(t, tz) === '09:00', 'monthly:5 墙钟=09:00', wallClockAt(t, tz));
}

// 4) daily 重排：未来第一个 08:00 应晚于 now 且墙钟为 08:00
{
  const tz = 'Asia/Shanghai';
  const now = Date.now();
  const t = computeNext('08:00', 'daily', now, tz);
  assert(t > now, 'daily 重排给出未来触发', String(t));
  assert(wallClockAt(t, tz) === '08:00', 'daily 墙钟=08:00', wallClockAt(t, tz));
}

// 5) 非法输入：时间格式错误（不满足 HH:MM 两位分钟）/ recurrence=none 返回 null
{
  assert(computeNext('12:345', 'daily', Date.now(), 'Asia/Shanghai') === null, '非法时间格式（分钟 3 位）→ null');
  assert(computeNext('ab:cd', 'daily', Date.now(), 'Asia/Shanghai') === null, '非法时间格式（非数字）→ null');
  assert(computeNext('08:00', 'none', Date.now(), 'Asia/Shanghai') === null, 'recurrence=none → null');
  assert(nextTriggerMs({ recurrence: 'none' }) === null, 'nextTriggerMs 无 date/time/timestamp → null');
}

console.log('\n结果： ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
