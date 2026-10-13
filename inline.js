/* 把 nlu.js 重新内联到 index.html 的第 1 个 <script> 块，保持浏览器与 Node 引擎一致 */
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const htmlPath = path.join(dir, 'index.html');
const enginePath = path.join(dir, 'nlu.js');
let html = fs.readFileSync(htmlPath, 'utf8');
const engine = fs.readFileSync(enginePath, 'utf8');
const open = '<script>';
const start = html.indexOf(open);
if (start < 0) { console.error('未找到 <script>'); process.exit(1); }
const end = html.indexOf('</script>', start);
if (end < 0) { console.error('未找到 </script>'); process.exit(1); }
const before = html.slice(0, start);
const after = html.slice(end); // 含 '</script>'
fs.writeFileSync(htmlPath, before + open + '\n' + engine + '\n' + after);
console.log('✓ 已将 nlu.js 重新内联到 index.html 的第 1 个 <script> 块');
