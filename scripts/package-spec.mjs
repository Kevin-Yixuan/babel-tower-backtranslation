// 发布包内容契约。
//
// ROOT_FILES / RUNTIME_DIRS 不是随手写的：update-unpacked.ps1 在更新时会逐个检查
// $rootFiles 和 mdx / modules / sidebar 三个目录，缺任何一项就拒绝更新。包结构与
// 更新脚本的期望必须一致，否则社群用户会装出一个"更新器认不出来"的版本。

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
  'shared.js',
  'writing.html',
  'writing.js',
  'writing.css',
  'update-unpacked.ps1',
  '安装与更新.md'
];

export const RUNTIME_DIRS = ['mdx', 'modules', 'sidebar'];

// 通用安装说明：优先随包内附的《安装与更新》，README 的「下载与安装」作为兜底。
export const INSTALL_DOC_CANDIDATES = ['安装与更新.md', 'README.md'];

export const MARKER_FILE = 'update-marker.json';

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
  { pattern: /(^|\/)(secrets?|credentials)\./i, reason: '可能的密钥文件' }
];

export function packageDirName(version) {
  return `${PACKAGE_BASENAME}-${version}`;
}

export function zipName(version) {
  return `${packageDirName(version)}.zip`;
}

export function checksumName(version) {
  return `${zipName(version)}.sha256`;
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
  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) refs.add(file);
    for (const file of script.css ?? []) refs.add(file);
  }
  for (const file of manifest.web_accessible_resources ?? []) {
    if (typeof file === 'string') refs.add(file);
  }
  return [...refs].sort();
}
