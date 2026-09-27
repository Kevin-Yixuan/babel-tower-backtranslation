# 0.3.0 集成与验收（2026-09-27）

起点：`feature/chrome-foundation` / `714cbe7`，manifest/package 0.2.3。远端发布及 tags 已两次核验，最新为 `v0.2.2`（2026-09-25）；本次版本 0.3.0。承接分支已有的设置、会话、备份、阅读与回复迭代，没有覆盖旧提交。

## 移植范围

从 `x-language-bridge/dictionary` 未提交工作树选取 Agent 传输和数据辅助函数、`write/` 写作台及 Markdown 测试。原工作树未写入。旧版 background/content/popup/manifest 未整文件覆盖：新增服务 `services/agent.js`、`services/agent-data.js`，侧栏通过 `modules/agent/agent.js` 注册；设置接入既有 `services/settings.js` 与独立设置页。

新增运行时地址白名单、禁止重定向、可选主机权限检查、OpenCode Basic 服务密码、写入串行化、跨帖结果隔离、文稿超限拒绝，以及 Agent 草稿的 AI 来源标记。原翻译模型、会话格式、回复插入校验和 `writing.html` 保留。文稿与本地 Agent 历史纳入备份；密钥、密码与远端会话 ID 不导出。相同文稿或 Agent 会话 ID 导入时保留本地记录。

`write/` 和隐私说明加入包白名单。仍无需构建即可直接加载扩展。Agent 本地历史保留最近 20 个会话、每个最近 24 条消息；OpenCode 远端历史由服务管理。完整说明见根目录 `privacy.md`。

## 验证结果

- `npm test`：121/121，退出码 0。新增 Agent 服务、端点／权限／认证／工具禁用／并发保存／失败保留记录测试及 Markdown 渲染测试。
- `node --test tests/packaging.test.mjs`：16/16，退出码 0。新增真实源码打包测试，逐字节核对四个 `write/` 文件、Agent 服务／侧栏模块与隐私文件。
- `npm run test:browser`：完整 16 个脚本串行入口通过，退出码 0；含 `ux-browser.cjs` 10/10 与新增 `agent-smoke.cjs`。未跳过既有套件，未削弱 CI 门禁。
- 最终 preview ZIP 解压到独立目录，设置 `EXTENSION_ROOT` 后运行 `agent-smoke.cjs` 与 `ux-browser.cjs`：均通过，后者 10/10。验证的是最终 ZIP 内的实际扩展。
- preview/store 两种 ZIP 均通过 `verify-package.mjs` 的布局、引用、版本和 SHA-256 校验，各含 51 个文件。
- `git diff --check` 通过。

浏览器测试使用隔离 Edge 配置、真实 MV3 后台／存储／消息链路与合成 X 页面，模型网络返回固定响应。新增 Agent 测试通过 Edge 扩展管理 API 授予隔离配置中的本地主机权限，再断言真实 `chrome.permissions.contains`；无头环境没有验证用户手动点击原生权限弹窗。没有替换发布包的 manifest 或伪造模型服务实测。

本地证据日志位于 `D:\个人网站\.tmp\agent-integration\`：`final-unit.log`、`final-packaging.log`、`final-browser.log`、`zip-agent.log`、`zip-ux.log`。这些本机临时文件不进入提交和 ZIP。

## 六个既有浏览器失败的处理

本轮逐项重跑交接中的失败，先确认失败位置，再修复并在完整入口复验：

1. `adversarial-smoke:171`：回复测试先点「翻译」，留下挂起翻译请求，之后误把它当生成请求放行。改用真实「回复」入口；候选区、取消、跨帖、IME 和超限断言保留。晚到提示在发生时断言，不要求跨两次会话恢复仍保留瞬时提示。
2. `timeline:257`：空地址按当前界面约定回退内置默认值，旧测试仍要求报错。改测明确无效 URL，并恢复有效 MiMo 地址后再验证多配置保存；保留 401、非 pong、权限及持久化断言。
3. `reading-smoke:150`：显式翻译缺密钥时提示未含 API Key；修复提示。后续旧测试假设刷新清除取材、选句自动发送；改为显式选全文／翻译选句，保留完整材料、晚到隔离及零请求断言。
4. `translation-controls:58`：实际缺陷，“重新翻译”重新命中旧缓存。点击重译时先删除相应缓存；使用当前“翻译当前内容”入口代替已移除的按钮，选句显式触发。原文回显拒绝、语言交换、手动材料和请求范围断言全部通过。
5. `reply-smoke:297`：切帖后提示词面板恢复为折叠，旧测试尝试直接输入隐藏字段。编辑前打开当前帖面板；帖子 URL 断言接受当前规范化的 `/i/status/222`。稿件来源、插入保护与原文保留断言均保留。
6. `release-regressions:37`：实际缺陷，从非帖子路由跳往另一非帖子路由时，手选的旧帖未清空。修复路由变化时清理旧上下文，并新增主机单测；长文章动态挂载、混合段落、会话隔离全部通过。

## 候选 ZIP

- preview：`dist/agent-0.3.0/babel-tower-backtranslation-0.3.0.zip`，189848 字节，SHA-256 `8f709e4f26a81ac8981c795ed1cde585a573a0c6a8ef0d7c454f565fa721c82e`。
- store：`dist/agent-0.3.0/store/babel-tower-backtranslation-0.3.0-store.zip`，186380 字节，SHA-256 `6114754280f428d1aaa0659fda56ad943db4f4f00e92493a711d39bf2f222feb`。

构建使用已核验的 `--previous 0.2.2`；没有使用 `--skip-remote-check`。ZIP 时间戳会使重新构建后的哈希变化，以上只对应本次实际文件。

## 验证边界与发布

本机 `http://127.0.0.1:11434/api/tags` 与 `http://127.0.0.1:4096/global/health` 均返回连接拒绝。**真实 Ollama、OpenCode、Ollama Cloud 和真实 X 均未验证**。OpenCode 每条消息的 `tools: {"*": false}` 已由请求测试覆盖，并核对官方源码将该配置映射到通配 deny；这不等同于真实服务端执行验证。参考：[Server](https://opencode.ai/docs/server/)、[官方 prompt 实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/session/prompt.ts)。

本次只提交 PR，不合并、不触发 Release、不上架。`release.yml` 在合并 main 且测试通过后自动发布社群预览版；审查者应把合并视为发布触发点。GitHub CI 结果应以 PR 检查页为准，本机通过不代表远端 CI 已通过。

用户的 `tests/zdebug-insert.cjs`、`tests/zdebug-race.cjs`、`tests/zdebug-reply.cjs` 保持未跟踪，未修改、未删除、未提交。
