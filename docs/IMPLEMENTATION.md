# 实施记录

基线：860c196e8aafebdcf8062aff1ad5d32fd78e2f39（远端 main、v0.2.2）。
迁入：原 babel-tower-public 工作区的未发布 0.2.3 修改，以及 PR #1 的打包脚本与测试。
原目录备份：D:\个人网站\babel-tower-implementation-backup-20260926。
开发目录：D:\个人网站\babel-tower-chrome。

用户选择由主智能体本地逐项完成，不启动子智能体；Orca 任务书作为后续交接。
本轮不创建公开 Release、不提交商店、不替换旧安装目录。

## T3 记录（商店候选包与审查问题）

- ZIP UTF-8 标志：`scripts/zip.mjs` 本地头与中央目录均置 0x800（EFS），由
  `tests/packaging.test.mjs` 断言两处标志 + Windows PowerShell 5.1（Expand-Archive 与
  .NET ZipFile）真实解压中文文件名验证覆盖。
- 打包文件清单：`scripts/package-spec.mjs` 的 ROOT_FILES 补入 `options.html`／`options.js`
  （manifest `options_page` 引用），完整候选提交可独立构建；缺必需文件或 manifest 引用缺失时
  构建必须失败（测试覆盖）。
- 退出未发布的本地自动更新路径：不再写入／校验 `update-marker.json`，`update-unpacked.ps1`、
  `update-marker.json` 由 DENY_PATTERNS 兜底拒绝且 verify-package 显式判失败；
  `tests.yml` 的「原地更新保持数据」job 移除；README 与《安装与更新》不再声称自动更新或已上架。
- 构建门禁：`--branch main` 分支门禁、远端 tag 查询失败阻断版本递增性检查（除非显式
  `--skip-remote-check`／`--previous`）、`--layout store` 商店提交候选布局。
  详见 `docs/store-submission.md`（含权限与隐私说明草稿与本轮候选 SHA-256）。
