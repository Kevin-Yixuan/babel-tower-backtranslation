// 版本号规则：Chromium 扩展的四段数字版本 + 本项目 release tag 形状。
// update-unpacked.ps1 只识别 ^v(\d+\.\d+\.\d+(?:\.\d+)?)$，所以发布版本必须 3 或 4 段。

export const CHROMIUM_SEGMENT_MAX = 65535;

// 返回数字数组；缺位在比较时按 0 补齐（Chromium 把 1.0 与 1.0.0.0 视为相等）。
export function parseVersion(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('版本号必须是非空字符串');
  }
  const segments = raw.split('.');
  if (segments.length > 4) {
    throw new Error(`版本号最多四段：${raw}`);
  }
  return segments.map((segment) => {
    if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) {
      throw new Error(`版本号每一段必须是无前导零的十进制整数：${raw}`);
    }
    const value = Number(segment);
    if (value > CHROMIUM_SEGMENT_MAX) {
      throw new Error(`版本号每一段不能超过 ${CHROMIUM_SEGMENT_MAX}：${raw}`);
    }
    return value;
  });
}

export function isChromiumVersion(raw) {
  try {
    parseVersion(raw);
    return true;
  } catch {
    return false;
  }
}

export function compareVersion(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 4; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

export function isStrictlyNewer(candidate, current) {
  return compareVersion(candidate, current) > 0;
}

// 发布版本在满足 Chromium 规则之外，还必须能被更新脚本的 tag 正则识别。
export function assertReleaseVersion(raw) {
  const segments = parseVersion(raw);
  if (segments.length < 3) {
    throw new Error(
      `发布版本至少三段（vX.Y.Z）：${raw}。update-unpacked.ps1 只识别 vX.Y.Z 与 vX.Y.Z.W。`
    );
  }
  return segments;
}

export function tagOf(version) {
  return `v${version}`;
}

export function versionOfTag(tag) {
  const trimmed = String(tag).replace(/^v/, '');
  assertReleaseVersion(trimmed);
  return trimmed;
}

// 从 tag 列表里挑出最大的合法发布版本（忽略 draft / 形状不合法的 tag）。
export function latestReleaseVersion(tags) {
  let best = null;
  for (const tag of tags) {
    if (!/^v(\d+(?:\.\d+){2,3})$/.test(tag)) continue;
    const version = tag.slice(1);
    if (best === null || compareVersion(version, best) > 0) best = version;
  }
  return best;
}
