# Chrome Web Store 提交候选与权限／隐私说明草稿

状态：**候选包已在本地构建并校验，未提交商店、未创建公开 Release、未上传任何内容。**
实际冻结与提交由协调者（T0）在冻结候选提交后执行。

## 一、候选产物（本轮本地构建）

| 产物 | 路径（仓库 `dist/`，已被 .gitignore 排除） | SHA-256 |
| --- | --- | --- |
| 商店提交候选 ZIP（store 布局，manifest.json 在 ZIP 根） | `dist/store/babel-tower-backtranslation-0.2.3-store.zip` | `8d4140f465f492fd554afc50feb2059b7acb426fa17c0f1b37415d9bfcffebe4` |
| 商店候选校验文件 | `dist/store/babel-tower-backtranslation-0.2.3-store.zip.sha256` | 同上 |
| 社群预览 ZIP（preview 布局，单层包装目录） | `dist/babel-tower-backtranslation-0.2.3.zip` | `40d48ffc484a965b26cb5f67bd3a3b48158c0cadedc8bfa366f04969e89b13ef` |
| 预览校验文件 | `dist/babel-tower-backtranslation-0.2.3.zip.sha256` | 同上 |
| 构建报告 | `dist/package-report.json`、`dist/store/package-report.json` | 42 个文件，manifest 0.2.3 |

注意：候选 ZIP 内容随源码变化；T0 冻结提交后必须**重新构建并重新记录 SHA-256**，
上表哈希只对应本报告生成时的工作树。

构建与校验命令（版本查询失败会阻断构建）：

```bash
node scripts/build-package.mjs --out dist/store --layout store   # 商店候选
node scripts/build-package.mjs --out dist                         # 预览候选
node scripts/verify-package.mjs dist/store/babel-tower-backtranslation-<版本>-store.zip --layout store --tag v<版本>
node scripts/verify-package.mjs dist/babel-tower-backtranslation-<版本>.zip --tag v<版本>
```

## 二、分支门禁与触发条件（按任务书；冻结由 T0 执行）

- **候选包只来自通过必需检查并合并的 `main`**：`.github/workflows/release.yml` 的构建步骤带
  `--branch main`，非 main 分支（含 `feature/chrome-foundation`）构建候选会被 `scripts/build-package.mjs`
  的分支门禁直接拒绝；`publish` job 另加 `github.ref == 'refs/heads/main'` 条件。
- 触发链：PR → `pr-tests.yml`（单元 + 浏览器 + 打包专项）→ 合并 `main` → `release.yml`
  （`tests.yml` 必需检查全绿才构建）→ 构建 preview + store 两套 ZIP → 校验 → 上传流水线产物。
- **版本查询失败阻断构建**：`git ls-remote --tags origin` 失败或包内版本不严格大于远端最新
  release tag 时构建报错退出；离线自测必须显式传 `--skip-remote-check` 或 `--previous`。
- 本轮**不创建公开 Release、不上传商店**；release.yml 的 publish 行为是否启用由 T0 决定。

## 三、权限说明草稿（对应 manifest.json，商店表单「权限」栏）

| 权限 | 类型 | 用途（逐条理由） |
| --- | --- | --- |
| `storage` | 普通权限 | 在浏览器本地保存设置、模型 API Key、草稿、收藏与学习记录（`chrome.storage.local`）。不用于跨设备同步。 |
| `https://api.dictionaryapi.dev/*` | 主机权限 | 在线词典兜底：用户查询单词且本地 MDX 词典未命中时，把**单个单词**发给 dictionaryapi.dev 取释义。 |
| `https://api.mymemory.translated.net/*` | 主机权限 | 在线翻译兜底：仅在用户选择该服务时发送待译文本。 |
| `https://api.openai.com/*` | 主机权限 | 用户在设置页自选 OpenAI 作为模型服务商时的翻译／生成／检查请求。 |
| `https://api.deepseek.com/*` | 主机权限 | 用户自选 DeepSeek 时的模型请求。 |
| `https://open.bigmodel.cn/*` | 主机权限 | 用户自选智谱 BigModel 时的模型请求。 |
| `https://api.typesafe.ai/*` | 主机权限 | 仅在用户**主动启用** Jev 规则折叠／兴趣高亮时，把附近帖文文本发给 TypeSafe 做分类。默认关闭。 |
| `https://*/*`、`http://localhost/*`、`http://127.0.0.1/*` | **可选**主机权限 | 用户填写自定义模型 Base URL 时按需申请；不填自定义地址就永远不会触发授权提示。 |

内容脚本匹配 `https://x.com/*`、`https://twitter.com/*`（仅在这两个站点注入读帖／侧栏脚本）。

## 四、隐私说明草稿（商店表单「数据使用」栏）

1. **开发者不收集任何数据。** 扩展没有自建服务器，不设账号，不含分析、统计、广告或追踪组件，
   不会把你的数据发送给扩展开发者。
2. **数据存放位置：** 设置、API Key、草稿、收藏、学习记录保存在浏览器本地
   （`chrome.storage.local`）；已导入的 MDX 词典索引保存在浏览器 IndexedDB。
   本地存储不等于操作系统钥匙串加密，请勿在共用浏览器中保存私人密钥。
3. **发送给第三方的内容（全部由你自己配置或启用触发）：**
   - 模型服务商（OpenAI／DeepSeek／智谱／自定义地址）：你点击翻译、生成、检查、讲解或测试连接时
     发送的帖子文本、草稿与提示词；「自动翻译」开启时打开帖子会自动发送原文（README 与设置页已注明可能计费）。
   - 在线词典（dictionaryapi.dev、Mymemory）：仅在在线兜底查词／翻译被使用时发送**单词或所选文本**。
   - TypeSafe（api.typesafe.ai）：仅在你启用 Jev 时发送附近帖文与规则，默认关闭。
   - 以上均为「传输给用户所选服务以完成功能」，不是开发者收集。
4. **不会做的事：** 不自动发布或修改你的 X 帖子（插入草稿也必须人工二次确认）；不读取浏览历史；
   不共享、不出售数据。
5. **删除数据：** 卸载扩展即移除其本地存储与 IndexedDB；设置页提供导出／清除入口。

## 五、本轮未验证项

- 未在 Chrome Web Store 开发者后台实际创建商品、未填写真实表单、未支付注册费、未上传 ZIP。
- 商店审核对 `optional_host_permissions` 中 `https://*/*` 的裁剪要求未验证（可能被要求收窄）。
- 商店渠道的自动更新、商店版权限弹窗、Edge Add-ons 双端上架均未做。
- 真实 X、真实模型输出下的功能验收仍按任务书留给 T7／人工检查。
