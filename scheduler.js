/* ============================================================
 * scheduler.js — 时区感知调度工具（夏令时安全）
 * 把「墙钟 日期+时间+IANA 时区」转为 UTC 毫秒，并计算重复闹钟的下一次触发。
 * 独立成模块便于单测（DST 跨时区回归）并减轻 server.js 职责。
 * 纯函数、无外部依赖，可在 Node 与浏览器（UMD 兼容）中复用。
 * ============================================================ */
'use strict';

// 计算某时区在给定 epoch 的 UTC 偏移（毫秒）：用 Intl 把 epoch 表示为目标时区的墙钟，
// 再当作 UTC 反推，二者之差即为该时刻的偏移。自动覆盖标准时/夏令时。
function tzOffsetAt(tz, epoch) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? 0 : (+p.hour);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUtc - epoch;
}

// 墙钟 → UTC 毫秒（夏令时边界二次修正：春进/秋退切换日偏移会突变，用目标时刻再算一次偏移消除误差）
function wallToEpoch(y, mo, d, hh, mm, tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  let off = tzOffsetAt(tz, guess);
  let utc = guess - off;
  const off2 = tzOffsetAt(tz, utc);
  if (off2 !== off) utc = guess - off2;
  return utc;
}

// 给定 epoch，返回它在指定时区里的日历日 {y,mo,d}
function tzDateParts(epoch, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map(x => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day };
}
function addDays(y, mo, d, n) {
  const dt = new Date(Date.UTC(y, mo - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); }
function weekdayOf(y, mo, d) { return new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); }

// 把闹钟子对象换算成下一次触发的毫秒时间戳
function nextTriggerMs(alarm) {
  const rec = alarm.recurrence || 'none';
  const tz = alarm.timezone || 'Asia/Shanghai';
  if (rec === 'none') {
    if (alarm.timestamp) return alarm.timestamp * 1000;
    if (alarm.date && alarm.time) {
      const [Y, M, D] = alarm.date.split('-').map(Number);
      const [hh, mm] = alarm.time.split(':').map(Number);
      return wallToEpoch(Y, M, D, hh, mm, tz);
    }
    return null;
  }
  const anchor = (alarm.timestamp || Math.floor(Date.now() / 1000)) * 1000;
  return computeNext(alarm.time, rec, anchor, tz);
}

// 计算下一次触发（时区感知，支持夏令时 + 月度）。以「时区内的日历日」为步进，避免本地与闹钟时区错位。
function computeNext(time, recurrence, anchorTs, timezone) {
  const tz = timezone || 'Asia/Shanghai';
  const now = Date.now();
  const [hh, mm] = time.split(':').map(Number);
  if (recurrence === 'none') return null;
  if (!/^\d{1,2}:\d{2}$/.test(time)) return null;
  const at = (y, mo, d) => wallToEpoch(y, mo, d, hh, mm, tz);
  if (recurrence === 'daily') {
    let cur = tzDateParts(now, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while (t < now && g < 400) { cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return t;
  }
  if (recurrence === 'weekdays') {
    let cur = tzDateParts(now, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while ((weekdayOf(cur.y, cur.mo, cur.d) === 0 || weekdayOf(cur.y, cur.mo, cur.d) === 6 || t < now) && g < 400) { cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return t;
  }
  if (recurrence === 'weekend') {
    let cur = tzDateParts(now, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while ((weekdayOf(cur.y, cur.mo, cur.d) !== 0 && weekdayOf(cur.y, cur.mo, cur.d) !== 6 || t < now) && g < 400) { cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return t;
  }
  if (recurrence.startsWith('weekly:')) {
    const w = parseInt(recurrence.split(':')[1], 10);
    let cur = tzDateParts(now, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while ((weekdayOf(cur.y, cur.mo, cur.d) !== w || t < now) && g < 400) { cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return t;
  }
  if (recurrence.startsWith('every:')) {
    const n = parseInt(recurrence.split(':')[1], 10) || 1;
    let cur = tzDateParts(anchorTs, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while (g < 600) { if (t >= now) return t; cur = addDays(cur.y, cur.mo, cur.d, n); t = at(cur.y, cur.mo, cur.d); g++; }
    return null;
  }
  if (recurrence.startsWith('biweekly:')) {
    const w = parseInt(recurrence.split(':')[1], 10);
    const EPOCH = Date.UTC(2024, 0, 1);
    const monOf = ts => { const x = tzDateParts(ts, tz); const dx = new Date(Date.UTC(x.y, x.mo - 1, x.d)); const o = (dx.getUTCDay() + 6) % 7; dx.setUTCDate(dx.getUTCDate() - o); return dx.getTime(); };
    let cur = tzDateParts(anchorTs, tz); let t = at(cur.y, cur.mo, cur.d), g = 0;
    while (g < 120) { const dow = weekdayOf(cur.y, cur.mo, cur.d); const wk = Math.round((monOf(t) - EPOCH) / (7 * 86400000)); if (dow === w && t >= now && wk % 2 === 0) return t; cur = addDays(cur.y, cur.mo, cur.d, 1); t = at(cur.y, cur.mo, cur.d); g++; }
    return null;
  }
  if (recurrence.startsWith('monthly:')) {
    const day = parseInt(recurrence.split(':')[1], 10);
    let cur = tzDateParts(now, tz); let y = cur.y, mo = cur.mo, g = 0;
    while (g < 36) {
      const dd = Math.min(day, daysInMonth(y, mo));
      const t = at(y, mo, dd);
      if (t >= now) return t;
      mo++; if (mo > 12) { mo = 1; y++; }
      g++;
    }
    return null;
  }
  return null;
}

// 把 epoch 在指定时区格式化成墙钟 HH:MM，用于测试断言（验证 DST 下墙钟不漂移）
function wallClockAt(epoch, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(epoch)).map(x => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  return hour + ':' + p.minute;
}

module.exports = {
  tzOffsetAt, wallToEpoch, tzDateParts, addDays, daysInMonth, weekdayOf,
  nextTriggerMs, computeNext, wallClockAt
};
