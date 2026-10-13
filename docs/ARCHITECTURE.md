# 架构

巴别塔是一个无构建步骤的 Manifest V3 扩展：内容脚本是普通脚本，后台和扩展页面是 ES 模块。代码注释里的「协议 §n」指本文对应章节。

```
X 页面 ──────────────────────────────┐        扩展页面
  content.js（宿主）                  │          popup.html · options.html
  sidebar/sidebar.js（骨架 window.BX）│          write/desk.html（写作台）
  modules/*/（页签）                  │                 │
          │ chrome.runtime.sendMessage│                 │
          ▼                           ▼                 ▼
                 background.js（MV3 service worker）
        settings · sessions · backup · pi-agent · mdx · 模型请求
          │                     │                       │
   chrome.storage.local    IndexedDB（会话、词典）  127.0.0.1:4097 Pi 桥接
```

## 1. 页面层

- **`content.js`**：扫描 `article[data-testid="tweet"]`，处理 X 虚拟列表的节点复用，在帖子下插入「翻译／回复」入口，跟踪聚焦的发帖框，并把设置广播给模块。
- **`sidebar/sidebar.js`**：侧栏外壳与 `window.BX`。负责页签、键盘导航、IME 保护（组合输入期间推迟重绘）、请求序号与取消。
- **`sidebar/context.js`**：`BXContext.key(url)` 把帖子的各种链接形式（作者路径、`/i/status/ID`、查询参数、twitter.com）归一成稳定的 `post:<id>`。
- **`sidebar/sessions.js`**：按帖保存与恢复侧栏状态。新输入优先于晚到的历史恢复，快速切帖不会串内容。

## 2. 侧栏共享状态与模块接口

模块通过 `BX.register()` 挂载：

```js
BX.register({
  id: 'agent', label: 'Pi', order: 25,   // order 决定页签顺序
  init() {},                            // 第一次显示时调用一次
  render(container) {},                 // 每次 BX.refresh() 重绘
  onPost(post, prev) {},                // 切换回复对象
  onArticle(article, meta) {},          // 新帖进入视口
  onEditor(editor) {},                  // 发帖框获得焦点
  onSettings(settings) {}
});
```

- `BX.state` 是共享状态。`mode` 由骨架管理，等于当前页签 id；`post`、`selected`、`draft`、`busy` 等字段为公共字段；**新增字段必须带模块前缀**。会话持久化的字段清单在 `services/session-fields.js`。
- `BX.busy(work)` 为请求分配序号；切帖或取消后，旧序号的结果一律丢弃，不覆盖用户输入。
- 事件总线 `BX.on / BX.emit`：`post-change`、`settings`、`cards-changed`、`user-draft`（§5）、`agent-prefill`（回复页把草稿交给 Pi）等。

## 3. 后台消息

所有消息形如 `{ action, ...payload }`，返回 `{ ok, data | error, code }`。

| 分组 | action |
| --- | --- |
| 设置 | `PUBLIC_SETTINGS` `PRIVATE_SETTINGS` `SAVE_SETTINGS` `TEST_MODEL` `OPEN_SETTINGS` |
| 模型任务 | `AI`（§3.1） |
| 词典 | `LOOKUP` `MDX_SUGGEST` `MDX_NEIGHBOURS` `IMPORT_GLOSSARY` |
| 存储 | `STORE`（§3.2） `SAVE_CARD` `LIST_CARDS` `DELETE_CARD` `SESSION` `BACKUP` |
| 筛选 | `JEV` `JEV_STATUS`（§3.3） |
| 写作与 Pi | `AGENT_STATUS` `AGENT_CHAT` `LIST_AGENT_SESSIONS` `RESET_AGENT_SESSION` `LIST_DOCUMENTS` `GET_DOCUMENT` `SAVE_DOCUMENT` `DELETE_DOCUMENT` `OPEN_WRITE_DESK` |

### 3.1 模型任务注册

各模块在 `modules/<feature>/*-tasks.js` 中导出任务表（提示词、输出 schema、输入校验），`background.js` 合并后统一分发，不需要修改后台。所有输入先经 `assertTextLimit` 校验：超限报错，不截断。

### 3.2 本地存储白名单

`STORE` 只允许访问白名单键：可读写 `initPrompt` `growthMemories` `growthSettings` `savedPhrases` `discoveryPrefs` `readingPrefs`，只读 `writingDrafts` `cards`。单个值不超过 500 KB。扁平写法 `{ op, key, value }` 和嵌套写法 `{ payload: { op, key, value } }` 都接受。

### 3.3 筛选与兴趣高亮

Jev 折叠和兴趣高亮共用每日调用上限和串行队列；规则分别保存在 `settings.filterRules` 和 `discoveryPrefs.interestRules`。`JEV_STATUS` 向 X 页面提供诊断计数。

## 4. 存储

| 位置 | 内容 |
| --- | --- |
| `chrome.storage.local`（仅可信上下文可访问） | 设置、API Key、Pi 令牌、收藏、成长记录、写作台文稿、Pi 会话 |
| IndexedDB `babel-tower-sessions` | 按帖保存的侧栏会话 |
| IndexedDB（mdx） | 导入的 MDX 词典索引 |

内容记录的读-合并-写操作统一经过 `services/content-storage.js` 的串行队列，模型请求不进入这个队列。备份导入、文稿保存和 Pi 回复入库因此不会互相覆盖。文稿保存会核对版本号，多窗口冲突时另存「冲突副本」。

## 5. 稿件来源规则

每份回复草稿带 `origin`：模型生成或采用、且之后没有手改的稿件是 `ai`，用户任何亲手键入都会变成 `user`。检查完成时通过 `user-draft` 事件上报。成长模块**只**把 `origin === 'user'` 的稿件当作学习证据，AI 代写永远不算用户已经掌握。

## 6. 插入 X 发帖框

`modules/reply/reply.js` 的插入分两步：

1. **解析目标**：优先选择回复弹层里唯一的编辑框，并用原帖链接或唯一的帖文正文核对它属于当前回复对象。无法确定时只提供复制，绝不退而写入页面上第一个编辑框。
2. **确认后写入**：重新核对目标仍然连接、可见、归属未变。写入时派发带纯文本的 `paste` 事件，让 X 的 Draft.js 编辑器用自己的状态渲染（原生 `insertText` 会让界面重复显示同一段文字）；编辑器没有处理时才回退 `execCommand`。已有文字时追加到末尾。

## 7. Pi 桥接

`pi-bridge/server.mjs` 只监听 `127.0.0.1:4097`，只接受扩展来源，并要求启动时生成的 Bearer 令牌。同一时间只处理一个请求，长材料通过标准输入传给 Pi，并限制超时和输出长度。扩展端（`services/pi-agent.js`）拒绝重定向，发送前检查总长度（80,000 字符），回复超过 40,000 字符时整段拒绝，不保存截断结果。

## 8. 测试

| 层 | 位置 | 说明 |
| --- | --- | --- |
| 单元 | `tests/*.test.mjs` | `npm test`；后台服务、存储、备份、Markdown、桥接 |
| 打包 | `tests/packaging.test.mjs` | 白名单打包、ZIP 结构、版本门禁 |
| 浏览器 | `tests/*.cjs` | `npm run test:browser`；隔离 Edge 加载真实扩展，用本地仿真的 X 页面，只替换外部网络 |
