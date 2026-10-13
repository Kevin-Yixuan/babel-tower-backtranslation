# 发布流程

## 一次发布

1. 在功能分支上同步提升版本号：`manifest.json`、`package.json`、`package-lock.json` 三处保持一致，并在 [CHANGELOG.md](../CHANGELOG.md) 顶部新增一节。
2. 开 PR。`pr-tests.yml` 会运行 Node 单元测试、打包测试，以及在 Windows + Edge 上运行的浏览器测试。
3. 合并到 `main` 后，`release.yml` 会依次执行：
   - 重新跑一遍完整测试，失败即停止；
   - 核验这次提交来自已合并的 PR，直接推送到 `main` 不会发布；
   - 构建两个包：`preview` 社群预览 ZIP，和 `store` Chrome Web Store 候选 ZIP；
   - 校验 ZIP 结构、manifest 引用、版本号和 SHA-256；
   - 创建 `v<版本>` tag 和 GitHub Release，附上 ZIP 和 `.sha256`。

版本号必须严格大于远端最新的 release tag，远端查询失败也会阻断构建。手动运行 `release.yml` 时默认 `dry_run`，只构建、不发布。

## 本地构建

```bash
node scripts/build-package.mjs --out dist --previous <上一版本>
node scripts/build-package.mjs --out dist/store --layout store --previous <上一版本>
node scripts/verify-package.mjs dist/babel-tower-backtranslation-<版本>.zip --expect-version <版本>
```

打包采用白名单（`scripts/package-spec.mjs`），只包含运行文件、`README.md`、`privacy.md` 和《安装与更新》。测试、文档、截图和词典文件不会进入安装包。ZIP 里带构建时间戳，所以每次构建的哈希都不同，但同一源码构建出的文件内容一致。

## 仓库设置

`main` 的分支保护需要在 GitHub 设置中开启：要求通过 `PR tests` 检查后才能合并，并禁止直接推送。
