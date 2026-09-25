// Playwright 可移植加载器（所有 tests/*.cjs 共用）：
//   1. 环境变量 PLAYWRIGHT_PATH —— 指向 playwright 模块（require 路径或目录）
//   2. 仓库 devDependency —— npm i -D playwright
// 换机器时用 1 或 2 即可，不需要改测试源码。
const path = require('node:path');

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_PATH) candidates.push(process.env.PLAYWRIGHT_PATH);
  try { candidates.push(require.resolve('playwright', { paths: [path.join(__dirname, '..')] })); } catch { /* not installed */ }
  const errors = [];
  for (const candidate of candidates) {
    try { return require(candidate); } catch (error) { errors.push(`${candidate}: ${error.message}`); }
  }
  throw new Error(
    '找不到 Playwright。请任选其一：\n' +
    '  a) npm i -D playwright（并安装浏览器：npx playwright install chromium 或使用本机 Edge channel）\n' +
    '  b) 设置环境变量 PLAYWRIGHT_PATH 指向 playwright 模块路径\n' +
    '尝试记录：\n' + errors.map(line => '  - ' + line).join('\n')
  );
}

module.exports = { loadPlaywright };
