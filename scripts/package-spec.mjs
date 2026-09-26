// 发布包内容契约。
//
// ROOT_FILES / RUNTIME_DIRS 描述「完整候选提交可以独立构建出可加载扩展」所需的
// 全部文件：根目录白名单 + 运行期真正会被 import / 引用到的目录（background.js
// 依赖 services/，内容脚本与后台都依赖 mdx / modules / sidebar）。
// manifest 的 options_page 指向 options.html，options.html 又加载 options.js，
// 因此这两个文件必须在白名单里，否则包加载后设置页直接报错。
// 已退役的本地自动更新机制（update-unpacked.ps1、update-marker.json）从未随任何
// 正式渠道发布，也不再打包：白名单天然排除它们，DENY_PATTERNS 兜底拒绝（尤其
// 防止它们混进 mdx/modules/services/sidebar 目录），见下方注释。

export const PACKAGE_BASENAME = 'babel-tower-backtranslation';

export const ROOT_FILES = [
  'README.md',
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.js',
  'popup.css',
  'options.html',
  'options.js',
  'shared.js',
  'writing.html',
  'writing.js',
  'writing.css',
  '安装与更新.md'
];

// 已退役的更新机制文件名：出现在 ZIP 内一律视为缺陷（verify-package 会据此失败）。
export const RETIRED_UPDATE_FILES = ['update-unpacked.ps1', 'update-marker.json'];

export const RUNTIME_DIRS = ['mdx', 'modules', 'services', 'sidebar'];

// 通用安装说明：优先随包内附的《安装与更新》，README 的「下载与安装」作为兜底。
export const INSTALL_DOC_CANDIDATES = ['安装与更新.md', 'README.md'];

// 任何命中即拒绝进入发布包。用白名单收集 + 黑名单兜底，避免把测试截图、
// 本地密钥、内部交接资料或词典数据打进 ZIP。
export const DENY_PATTERNS = [
  { pattern: /(^|\/)\.git(\/|$)/, reason: '版本库元数据' },
  { pattern: /(^|\/)\.github(\/|$)/, reason: 'CI 工作流' },
  { pattern: /(^|\/)node_modules(\/|$)/, reason: '依赖目录' },
  { pattern: /(^|\/)tests(\/|$)/, reason: '测试代码与测试截图' },
  { pattern: /(^|\/)\.workbuddy(\/|$)/, reason: '本地协作数据' },
  { pattern: /(^|\/)(dist|build|out)(\/|$)/, reason: '构建产物' },
  { pattern: /(^|\/)\.env(\.|$)/i, reason: '可能的密钥文件' },
  { pattern: /(^|\/).*\.local$/, reason: '本地私有文件' },
  { pattern: /\.(png|jpe?g|gif|webp|bmp|ico)$/i, reason: '图片（含测试截图）' },
  { pattern: /\.(mdx|mdd)$/i, reason: '词典数据文件' },
  { pattern: /\.(zip|7z|rar|tar|tgz|gz)$/i, reason: '压缩包' },
  { pattern: /\.(log|tmp|bak)$/i, reason: '临时或日志文件' },
  { pattern: /\.(pem|key|p12|pfx)$/i, reason: '密钥文件' },
  { pattern: /(^|\/)HANDOFF\.md$/i, reason: '内部交接资料' },
  { pattern: /(^|\/)使用说明-.*\.md$/, reason: '版本专属内部说明' },
  { pattern: /(^|\/)(secrets?|credentials)\./i, reason: '可能的密钥文件' },
  // 已退役的本地自动更新机制：脚本与完成标记都从未随任何版本发布，也不再打包。
  { pattern: /(^|\/)update-unpacked\.ps1$/i, reason: '已退役的本地自动更新脚本' },
  { pattern: /(^|\/)update-marker\.json$/i, reason: '已退役的更新完成标记' }
];

export function packageDirName(version) {
  return `${PACKAGE_BASENAME}-${version}`;
}

// 布局：preview（默认）ZIP 第一层是单一扩展目录，用于 GitHub Release 解压安装；
// store 是 Chrome Web Store 提交候选，文件平铺在 ZIP 根（manifest.json 在第一层）。
// store 布局的 ZIP / 校验文件名带 -store 后缀，避免与 preview 产物互相覆盖。
export const LAYOUTS = ['preview', 'store'];

export function zipName(version, layout = 'preview') {
  const suffix = layout === 'store' ? '-store' : '';
  return `${packageDirName(version)}${suffix}.zip`;
}

export function checksumName(version, layout = 'preview') {
  return `${zipName(version, layout)}.sha256`;
}

export function denyReason(relativePath) {
  const normalized = relativePath.split('\\').join('/');
  for (const item of DENY_PATTERNS) {
    if (item.pattern.test(normalized)) return item.reason;
  }
  return null;
}

// manifest 里直接引用的文件，必须都在包里，否则加载即报错。
export function manifestReferencedFiles(manifest) {
  const refs = new Set();
  if (manifest.background?.service_worker) refs.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) refs.add(manifest.action.default_popup);
  if (manifest.options_page) refs.add(manifest.options_page);
  if (manifest.options_ui?.page) refs.add(manifest.options_ui.page);
  if (manifest.devtools_page) refs.add(manifest.devtools_page);
  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) refs.add(file);
    for (const file of script.css ?? []) refs.add(file);
  }
  for (const file of manifest.web_accessible_resources ?? []) {
    if (typeof file === 'string') refs.add(file);
    else if (file && Array.isArray(file.resources)) {
      for (const resource of file.resources) refs.add(resource);
    }
  }
  return [...refs].sort();
}
