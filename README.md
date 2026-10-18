# 巴别塔（回译）

[![Tests](https://github.com/Kevin-Yixuan/babel-tower-backtranslation/actions/workflows/pr-tests.yml/badge.svg)](https://github.com/Kevin-Yixuan/babel-tower-backtranslation/actions/workflows/pr-tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Kevin-Yixuan/babel-tower-backtranslation)](https://github.com/Kevin-Yixuan/babel-tower-backtranslation/releases)

在 X（Twitter）上读懂外语、用自己的话回复的浏览器扩展。阅读时翻译、查词、讲解句子；回复时先用中文说清想法，再生成目标语言草稿，并用「回译」核对意思有没有走样。只做这一件事：在 X 页面上读懂外语、说出地道的外语，并用回译确认意思没跑偏。

<p align="center">
  <img src="docs/images/sidebar-reply.png" width="280" alt="侧栏回复">
  <img src="docs/images/popup.png" width="250" alt="扩展弹窗">
</p>

## 功能

| | |
| --- | --- |
| **阅读** | 帖子和长文一键翻译，可选原文／译文语言、全文／划选／手动输入取材；划词查词（本地 MDX 词典优先，在线兜底）；句子讲解与收藏。超过 20,000 字符明确提示拆分，绝不静默截断。 |
| **回复** | 用中文写想法 → 目标语言完整草稿 → 中文回译、意思风险、逐项修改建议。插入 X 发帖框前必须确认，核对回复对象，跨帖拒绝，非空时追加。**扩展从不点击发布。** |

## 安装

1. 从 [Releases](https://github.com/Kevin-Yixuan/babel-tower-backtranslation/releases) 下载最新的 `babel-tower-backtranslation-*.zip`，解压到一个**长期不移动**的目录（第一层应是 `manifest.json`）。
2. 打开 `chrome://extensions` 或 `edge://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」并选中该目录。
3. 刷新 `x.com`，帖子下会出现「翻译」「回复」。点扩展图标进入设置，选择模型服务商并填写自己的 API Key。

升级时把新版文件覆盖到**同一目录**再点「重新加载」，数据才会保留（不同目录会得到不同的扩展 ID）。扩展没有自动更新。详见 [安装与更新](安装与更新.md)。

## 隐私

没有开发者服务器，不含统计或追踪。API Key、草稿、收藏和词典索引只存在本机浏览器；内容只在你触发功能时发往**你自己配置**的模型服务。开启「自动翻译」后，打开帖子会自动发送原文，可能产生费用。详见 [privacy.md](privacy.md) 与 [权限说明](docs/PERMISSIONS.md)。

## 开发

无需构建，直接以「加载已解压的扩展程序」加载仓库目录即可调试。

```bash
npm test                              # Node 单元测试
node --test tests/packaging.test.mjs  # 打包与发布脚本测试
npm i -D playwright && npm run test:browser   # 隔离 Edge + 真实 MV3 扩展 + 仿真 X 页面
```

浏览器测试不访问真实 X、不使用真实密钥，只替换外部网络。也可用 `PLAYWRIGHT_PATH` 指向已安装的 Playwright。

```
background.js        MV3 后台：消息路由、模型请求、存储白名单
content.js           X 页面宿主：扫描帖子、帖内入口、编辑框跟踪
sidebar/             侧栏骨架（window.BX）、会话恢复、帖子身份
modules/<feature>/   两个页签：reading（翻译）· reply（回复）
services/            设置、会话、备份等后台服务
mdx/                 本地 MDX 词典解析与索引
scripts/             打包、校验、版本门禁
```

**0.6 起范围收缩**：写作台、Pi/Agent、Jev 筛选、回译练习与成长记忆已移除，保留离线 MDX 词典。加新功能前先问：离开这个网页还能做吗？依赖当前页面上下文吗？我自己每天会用吗？

架构与模块约定见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，发布流程见 [docs/RELEASING.md](docs/RELEASING.md)，版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 反馈

请在 [Issues](https://github.com/Kevin-Yixuan/babel-tower-backtranslation/issues) 附上浏览器版本、复现步骤和去敏后的页面结构。不要上传密钥、令牌或私人帖子内容。

## 许可证

[MIT](LICENSE)
