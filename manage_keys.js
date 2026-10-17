#!/usr/bin/env node
'use strict';
/*
 * manage_keys.js — 闹钟 Agent 开放 API 密钥管理（自托管阶段）
 * 用法：
 *   node manage_keys.js create --label "我的应用" --rate 100 --plan pro --default-timezone Asia/Shanghai
 *   node manage_keys.js list
 *   node manage_keys.js disable <key>
 *   node manage_keys.js enable  <key>
 * 数据存放于 data/alarm.db（与 server.js 共用 db.js）。
 */
const db = require('./db.js');

const [, , cmd, ...rest] = process.argv;

if (cmd === 'create') {
  const labelIdx = rest.indexOf('--label');
  const label = labelIdx >= 0 ? rest[labelIdx + 1] : null;
  const rateIdx = rest.indexOf('--rate');
  const rate = rateIdx >= 0 ? parseInt(rest[rateIdx + 1], 10) : undefined;
  const planIdx = rest.indexOf('--plan');
  const plan = planIdx >= 0 ? rest[planIdx + 1] : 'free';
  const tzIdx = rest.indexOf('--default-timezone');
  const defaultTimezone = tzIdx >= 0 ? rest[tzIdx + 1] : null;
  const rec = db.createKey({ tenant: 'custom', label, rate_limit: rate, plan, default_timezone: defaultTimezone });
  console.log('已创建 API Key：');
  console.log('  ' + rec.key);
  console.log('  label=' + rec.label + '  plan=' + rec.plan + '  rate_limit=' + rec.rate_limit + '/min' + '  default_timezone=' + (rec.default_timezone || 'Asia/Shanghai(默认)'));
  console.log('调用示例：');
  console.log('  curl -X POST http://localhost:8080/v1/parse \\');
  console.log('    -H "Authorization: Bearer ' + rec.key + '" \\');
  console.log('    -H "Content-Type: application/json" \\');
  console.log('    -d \'{"text":"明天早上8点叫我起床"}\'');
} else if (cmd === 'list') {
  // 列出库中全部密钥（跨租户，自托管运维视角）
  const rows = db.listAllKeys();
  if (!rows.length) return console.log('（无密钥，启动 server.js 会自动生成一枚示例 key）');
  console.log('共 ' + rows.length + ' 枚密钥：');
  rows.forEach(k => console.log('  ' + (k.enabled ? '✓' : '✗') + ' ' + k.key + '  [' + (k.label || '') + ']  plan=' + k.plan + '  rate=' + k.rate_limit + '/min  tenant=' + k.tenant));
} else if (cmd === 'disable' || cmd === 'enable') {
  const target = rest[0];
  if (!target) return console.log('请提供要' + (cmd === 'disable' ? '禁用' : '启用') + '的 key');
  const k = db.getKey(target);
  if (!k) return console.log('未找到该 key');
  db.setKeyEnabled(target, cmd === 'enable');
  console.log('已' + (cmd === 'enable' ? '启用' : '禁用') + ' ' + target);
} else {
  console.log('闹钟 Agent 密钥管理');
  console.log('用法：');
  console.log('  node manage_keys.js create --label "我的应用" --rate 100 --plan pro --default-timezone Asia/Shanghai   生成新密钥');
  console.log('  node manage_keys.js list                                       列出全部密钥');
  console.log('  node manage_keys.js disable <key>                              禁用密钥');
  console.log('  node manage_keys.js enable  <key>                             启用密钥');
}
