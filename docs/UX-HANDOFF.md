# 回译体验迭代 · 实现与自测交接

日期：2026-09-26。执行者：本轮实现与自测 Agent。后续由 Astra 独立验收。

## 1. 起止提交

| 项 | 值 |
| --- | --- |
| 起点提交 | `7b069c0dbf6a8d6c8939dc54cca72b9b6a613f9d`（T3 集成：商店候选打包管线…） |
| 起点状态 | 该提交上存在上一位 Agent 留下的**未提交**第一轮实现（9 个已改文件 + 8 个未跟踪文件），本轮在其基础上继续，未 reset / clean / 覆盖 |
| 代码止点 | `892e797b0df39a8a6186e30271775543a25e9f89`（第二轮完成） |
| 当前 HEAD | `4da6164b8b344a66b95f01546b2af910c082989e`（仅本交接文档，**无代码改动**，与 `892e797` 的包内容一致） |
| 分支 | `feature/chrome-foundation`（**未推送**） |
| 中间提交 | `767cecc` 第一轮 阅读到回复；`892e797` 第二轮 配置到恢复；`4da6164` 交接文档 |
| 规格 | `docs/UX-PLAN.md`（用户 2026-09-26 确认） |

未发布、未推送、未上架、未创建公开 Release、未替换日用扩展目录、未使用真实密钥、未点击 X 发布按钮。

## 2. 修改内容

### 第一轮 阅读到回复（`767cecc`，13 个文件）

- `modules/reply/reply.js`：插入目标改用 `BXContext.key` 稳定帖子身份。作者链接、`/i/status/ID`、查询参数、X/Twitter 域名形式视为同一帖；跨帖、未知目标、全局发帖框一律拒绝写入；确认时重新校验编辑框归属（article / dialog 两种路径）。
- `services/session-fields.js`（新增）+ `manifest.json` + `services/sessions.js`：会话字段定义单一来源，供普通内容脚本与 MV3 后台共用；新增 `readingInput` 按帖保存取材模式、未提交手动原稿与语言方向。旧会话缺字段兼容读取，不清空旧数据。
- `sidebar/sessions.js`、`sidebar/sidebar.js`：`switchTo` 支持 `edits`，新增 `touched` 集合；新划选/新输入优先于异步历史恢复，快速 A→B→A 不串内容。
- `modules/reading/reading.js`：恢复意图、阅读输入状态、停止/重试状态机。重试只把 `error` 段落改回 `pending`，成功段保留；停止后未发出的段落不排队，并如实提示“已发出的请求可能计费”。
- `modules/reading/hover-lookup.js` + `reading.js` 的 `BXWordBoundary`：悬停与划词共用同一词界规则，覆盖数字、连字符、弯引号与跨内联元素。
- `content.js` + `reading.js` 的 `translate-full` 处理器：**本轮接手后修复的缺陷**（见 §3）。
- `tests/ux-browser.cjs`（新增）：真实扩展浏览器回归，只替换外部网络；已接入 `test:ux` 与标准入口 `test:browser`。
- `tests/sessions.test.mjs`：新增恢复期间新选句、三取材状态+手动原稿随会话保存的用例。

### 第二轮 配置到恢复（`892e797`，6 个文件）

- `options.html` + `options.js`：
  - 新增 `#settings-dirty-status`，区分生效配置与未保存表单；保存成功才清标记，失败保留原配置与输入并允许重试；保存期间按钮禁用防重复提交；只有 `dirty` 时 `beforeunload` 才 `preventDefault`。
  - 连接测试绑定发起时的配置与表单版本（`testRun` + `formVersion`）：切换配置或编辑后晚到的结果不回写，只提示“已忽略”；测试本身不落库。
  - 历史列表重写：`#session-search` 搜索（匹配 key/sourceKey/摘要/原始 JSON）、每页 20 条 +「显示更多」、摘要、更新时间、`冲突副本` 标记、原帖链接、「复制草稿」、原始 JSON 折叠为「技术详情」、删除前确认并提示备份。
  - 备份预览与合并结果展示「导入 X 项、跳过 Y 项、另存 Z 项」。
- `services/settings.js`：新增 `readSettings` / `readApiKeys` / `publicSettings` / `saveSettings`，成为保存的**唯一实现**。
- `background.js`：改为注入 `chrome.storage.local`，删除本文件内的 `saveSettings` 副本。
- `services/backup.js`：新增 `planImport` / `previewBackup`，预览与实际导入共用同一套判定，返回导入/跳过/另存数量；`importBackup` 返回值附加同名统计。
- `tests/settings-page.test.mjs`：**删除复刻后台的 `saveSettingsLikeBackground`**，`SAVE_SETTINGS` 改走 `services/settings.js` 的真实 `saveSettings`；存储桩扩展为真实 get/set/remove；DOM 桩补 `#settings-dirty-status`、`#session-search`、`window` 事件接口。

## 3. 缺陷：失败 → 定位 → 修复 → 通过

### 缺陷 A（本轮接手，最高优先级）：manual 回归 `full !== manual`

| 阶段 | 证据 |
| --- | --- |
| 复现 | `$env:UX_ONLY='manual:'; node tests/ux-browser.cjs` → `FAIL manual: … returning from B to A restores manual scope` / `'full' !== 'manual'` |
| 定位 | 临时诊断读取存储：`post:7301` 的 `readingInput` 落库为 `{"scope":"full","manualText":"…UNSENT_7301.","source":"英语","target":"日语"}` —— 原稿和语言对，**唯独 scope 被写成 full**；DOM 轮询 3 秒始终 `full`，非渲染竞态 |
| 根因 | `content.js` 先 `emit('translate-full')` 再 `openForPost()`。处理器 `readScope='full'; rememberInput()` 在**会话仍绑定上一帖**时执行，把“全文”意图写进上一帖的会话记录；回到 A 时恢复的就是这条被污染的记录 |
| 修复 | ① `content.js`：先 `openForPost(article,'read')` 再发 `translate-full`，意图落到被点击的帖子；② `reading.js`：仅在 `!state.sessionLoading`（同帖、无恢复在进行）时强制全文，切帖由会话恢复决定取材；自动翻译入口等会话恢复完成后仅在 `readScope==='full'` 时启动，已恢复的手动原稿必须用户主动翻译 |
| 通过 | `PASS manual: unsubmitted material survives switch and reload`（“从 B 返回 A”与“刷新 A”两处断言均为原断言，未改期望） |

同一用例在基线上的失败与修复后的通过，见 §4 的 1/9 → 9/9 对照。

### 缺陷 B/C/D：第二轮三项体验缺失

均由 `tests/ux-browser.cjs` 在基线（本轮修改前的代码）上先复现，再实现，再通过：

| 用例 | 基线（修改前） | 本轮 |
| --- | --- | --- |
| `settings: unsaved form and late connection response` | FAIL：`#settings-dirty-status` 不存在，`innerText` 超时 | PASS |
| `history: search pagination copy and conflict visibility` | FAIL：`#session-search` 不存在，`waitFor` 超时 | PASS |
| `backup: visible conflicts and partial storage failure` | FAIL：预览缺少 `跳过 2`，实得 `将合并：0 个帖子会话…` | PASS |

复现与通过使用**同一份测试文件**（`tests/ux-browser.cjs`，两轮间未改其断言）。

## 4. 实际测试结果

### 4.1 必需命令（本机执行）

| 命令 | 结果 |
| --- | --- |
| `npm test` | **105/105 通过**（Node 本机单测，含 `sessions` / `settings-page` / `settings-core` 等） |
| `node --test tests/packaging.test.mjs` | **15/15 通过** |
| `npm run test:ux` | **9/9 通过**（隔离 Edge + 真实 MV3 扩展，仅替换外部网络） |
| `npm run test:browser` | **退出码 1（未全绿）**，见下表 |

### 4.2 `npm run test:browser` 逐套件结果

运行环境：隔离副本 `D:\个人网站\.tmp\ux-final-892e797`（含止点提交全部改动，无 `.git`，`node_modules` 为联接，**不含任何 `tests/*.png`**，因此不会覆盖用户原有截图证据）。链式入口在 `adversarial-smoke` 中止后，其余套件逐个执行。

| 套件 | 本轮 892e797 | 基线 7b069c0 | 判定 |
| --- | --- | --- | --- |
| `smoke.cjs` | PASS | **FAIL**（`smoke.cjs:117` 必须显示插入目标预览） | 由本轮修复 |
| `writing-smoke.cjs` | PASS | 未运行（基线链式在 smoke 中止） | — |
| `adversarial-smoke.cjs` | FAIL `:171` | FAIL `:171`（同位置） | **既有** |
| `workbench-smoke.cjs` | PASS | PASS | 一致 |
| `timeline.cjs` | FAIL `:257` | FAIL `:257`（同位置） | **既有** |
| `jev-adversarial.cjs` | PASS | PASS | 一致 |
| `dictionary-wiring.cjs` | PASS | PASS | 一致 |
| `reading-smoke.cjs` | FAIL `:150` | FAIL `:150`（同位置，同一断言、同一输出） | **既有** |
| `translation-controls.cjs` | FAIL `:58` | FAIL `:58`（同位置） | **既有** |
| `reply-smoke.cjs` | FAIL `:297` | FAIL `:297`（同位置，同一定位日志） | **既有** |
| `growth-logic.cjs` | PASS | PASS | 一致 |
| `growth-smoke.cjs` | PASS | PASS | 一致 |
| `discovery-smoke.cjs` | PASS | PASS | 一致 |
| `release-regressions.cjs` | FAIL `:37` | FAIL `:37`（同位置） | **既有** |
| `ux-browser.cjs`（本轮新增） | **PASS 9/9** | **FAIL 1/9**（见 §3） | 本轮新增并接通 |

**结论：本轮没有引入浏览器回归；6 项失败全部在 `7b069c0` 基线上以相同位置、相同断言单独复现，属既有缺陷，超出本次两轮范围，未修复。`smoke.cjs` 由本轮修复。**

基线对照运行（同一台机器、同一 Edge、同一测试文件）：

- 基线链式 `npm run test:browser`：`smoke.cjs:117` 失败即中止 → `D:\个人网站\.tmp\ux-baseline-browser.log`
- 基线单项：`D:\个人网站\.tmp\ux-baseline-adversarial.log`、`D:\个人网站\.tmp\ux-baseline-suite-results.txt`（timeline/reading）、`D:\个人网站\.tmp\ux-baseline-suite2.txt`（translation/reply/release + 通过项）
- 基线 UX 回归（把本轮 `tests/ux-browser.cjs` 放到基线副本运行）：**1/9** → `D:\个人网站\.tmp\ux-baseline-ux.log`

### 4.3 测试结果存放位置

- 隔离副本：`D:\个人网站\.tmp\ux-final-892e797`
- 本轮日志：`ux-final-browser.log`（链式）、`ux-final-suite-results.txt`（逐套件）、`ux-final-ux.log`（9/9）
- 本轮截图与机读结果：`D:\个人网站\.tmp\ux-final-evidence\`（9 张 PNG + `ux-results.json`）
- 基线副本：`D:\个人网站\.tmp\ux-baseline-7b069c0`（原始）、`D:\个人网站\.tmp\ux-baseline-check`（跑基线对照用，加了 `node_modules` 联接）

## 5. 候选包

构建命令（显式 `--previous 0.2.2` 做离线版本递增校验；**未使用 `--skip-remote-check`，未绕过其他任何检查**）：

```
node scripts/build-package.mjs --root . --previous 0.2.2 --layout preview
node scripts/build-package.mjs --root . --previous 0.2.2 --layout store
node scripts/verify-package.mjs dist/babel-tower-backtranslation-0.2.3.zip --layout preview --expect-version 0.2.3
node scripts/verify-package.mjs dist/babel-tower-backtranslation-0.2.3-store.zip --layout store --expect-version 0.2.3
```

| 候选包 | 路径 | 大小 | SHA-256 |
| --- | --- | --- | --- |
| preview | `D:\个人网站\babel-tower-chrome\dist\babel-tower-backtranslation-0.2.3.zip` | 164118 B / 43 文件 | `4466716394a4253ee1400e4cfdf6049da8777e534160962ded3d6812d37861bf` |
| store | `D:\个人网站\babel-tower-chrome\dist\babel-tower-backtranslation-0.2.3-store.zip` | 161194 B / 43 文件 | `a5890b3b3a3c93d5b998752f39f348e25423635618fddf2efb0a77119e45618c` |

两者 `verify-package` 均通过（结构、manifest 引用、已退役更新文件、布局、SHA-256 与 `.sha256` 侧车一致）。

> **SHA-256 说明**：ZIP 条目带构建时间戳，因此**每次构建的 SHA 都不同**，该哈希是“这一个交付物”的指纹而非源码的可复现哈希。已验证同一源码多次构建的**文件内容完全一致**（43 个文件逐个 SHA-256 比对 0 差异）。上表以**当前 `dist/` 下实际存在的两个 ZIP** 为准，验收时请对磁盘上的文件重新 `Get-FileHash` 核对。

**解压后加载验证**：`dist/babel-tower-backtranslation-0.2.3.zip` 用 `[System.IO.Compression.ZipFile]` 解压到 `D:\个人网站\.tmp\dev-zip-load`，以 `--load-extension` 在 Edge 中加载 → `ZIP_LOAD_PASS extensionId=oaolekhpcigpidnbbokpbdaonkbeajbl`：侧栏把手出现、点「翻译」后阅读页渲染、新帖默认全文取材、`#settings-dirty-status` 与 `#session-search` 存在、中文文件名《安装与更新.md》解压正常。

（隔离副本上曾用同一源码构建过一对包，文件内容经逐文件 SHA-256 比对与上表**完全一致**，差异仅来自 ZIP 条目时间戳；以仓库 `dist/` 下这对为准。）

## 6. 证据分级

| 类别 | 本轮是否执行 | 说明 |
| --- | --- | --- |
| Node 单测 | **是** | `npm test` 105/105、`packaging` 15/15 |
| 隔离浏览器 | **是** | Edge headless + 独立 profile + 真实 MV3 扩展加载；**唯一被替换的是外部网络 `fetch`**（模型、Jev、词典等接口由测试返回固定桩数据），存储/权限/剪贴板均为浏览器真实实现 |
| 真实 X（线上 x.com） | **否** | 全部为本地合成的 X 结构 HTML；未访问真实 X，未发布任何内容 |
| 真实模型 / 真实 API | **否** | 未调用任何真实模型；测试中不使用真实密钥，仅 `ux-test-placeholder` / `test-placeholder-key` 之类占位值 |
| 发布渠道 | **否** | 未发布、未推送、未上架、未创建 Release、未替换日用安装目录 |

## 7. 未验证 / 未完成项

1. `npm run test:browser` **未全绿**（退出码 1）。6 项既有失败（`adversarial-smoke:171`、`timeline:257`、`reading-smoke:150`、`translation-controls:58`、`reply-smoke:297`、`release-regressions:37`）已确认在 `7b069c0` 基线同位置复现，**本轮未修复**。
2. 真实 X 页面、真实模型、真实密钥的端到端行为**未验证**（见 §6）。
3. 未做像素级视觉回归；只保证保留原有配色、布局、原生 JavaScript 与无构建加载方式。
4. 未运行 `.github` 工作流 / CI。
5. 本轮临时诊断脚本 `tests/ux-debug-manual.cjs` 已删除，未进入交付。用户的 `tests/zdebug-insert.cjs`、`zdebug-race.cjs`、`zdebug-reply.cjs` **未修改、未删除、未提交**，仍为未跟踪状态。
6. 第二轮「冲突副本可查看/复制，不自动覆盖原记录」的**写入侧**行为由既有会话冲突逻辑保证（`sessions.test.mjs` 覆盖），本轮只补了设置页的展示与复制；未新增针对“冲突副本不能覆盖原记录”的浏览器用例。

## 8. Astra 验收提示

- 冻结提交：`4da6164b8b344a66b95f01546b2af910c082989e`（HEAD，仅含本交接文档；**代码内容 = `892e797b0df39a8a6186e30271775543a25e9f89`**）。起点 `7b069c0dbf6a8d6c8939dc54cca72b9b6a613f9d`。
- 包哈希见 §5，请以 `dist/` 下两个 ZIP 的 SHA-256 为准。
- 必需命令复核：`npm test`、`node --test tests/packaging.test.mjs`、`npm run test:browser`。
  前两项应全绿；第三项预期退出码 1，失败项应与 §4.2 基线列逐条一致——**若出现基线列之外的新失败，即为回归**。
- 浏览器证据请在包含冻结提交的隔离副本运行，避免覆盖 `tests/*.png` 与三个 `zdebug` 文件。
