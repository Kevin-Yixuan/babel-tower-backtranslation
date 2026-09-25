# One fixed unpacked directory keeps the browser extension ID and its local data.
# Run once with -InstallDir; add -RegisterDailyTask to check GitHub releases daily.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [switch]$DryRun,
  [switch]$RegisterDailyTask,
  [string]$At = '09:00',
  [string]$PackageZip = '',
  [string]$ChecksumFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = 'Kevin-Yixuan/babel-tower-backtranslation'
$taskName = 'BabelTowerBacktranslationUpdater'
$root = (Resolve-Path -LiteralPath $InstallDir).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $root 'manifest.json') -PathType Leaf)) {
  throw "安装目录没有 manifest.json：$root"
}
$installed = Get-Content -LiteralPath (Join-Path $root 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($installed.manifest_version -ne 3 -or $installed.name -notmatch '巴别塔|回译 X') {
  throw '该目录不是巴别塔（回译）扩展，已停止更新。'
}

function Register-UpdateTask {
  param([string]$Directory, [string]$DailyTime)
  $scriptPath = Join-Path $Directory 'update-unpacked.ps1'
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "安装目录没有更新脚本：$scriptPath"
  }
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Write-Output "每日任务 $taskName 已存在，未覆盖它。"
    return
  }
  try { $when = [datetime]::Today.Add([TimeSpan]::Parse($DailyTime)) }
  catch { throw '时间格式应为 HH:mm，例如 09:00。' }
  $exe = (Get-Command powershell.exe -ErrorAction Stop).Source
  $arguments = '-NoProfile -NonInteractive -File "' + $scriptPath + '" -InstallDir "' + $Directory + '"'
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -Daily -At $when
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Description '检查巴别塔（回译）GitHub 更新并原目录安装；不删除浏览器数据。' | Out-Null
  Write-Output "已注册每日 $DailyTime 检查任务：$taskName（登录此 Windows 账号时运行）。"
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$work = Join-Path $tempRoot ('babel-tower-update-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  if ($PackageZip) {
    if (-not $ChecksumFile) { throw '本地包测试需要同时指定 -ChecksumFile。' }
    $zipPath = (Resolve-Path -LiteralPath $PackageZip).Path
    $checksumPath = (Resolve-Path -LiteralPath $ChecksumFile).Path
    $expectedReleaseVersion = $null
  } else {
    $headers = @{ 'User-Agent' = 'BabelTowerUpdater'; 'Accept' = 'application/vnd.github+json' }
    $releases = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases?per_page=30" -Headers $headers)
    $candidates = @()
    foreach ($release in $releases) {
      if ($release.draft -or $release.tag_name -notmatch '^v(\d+\.\d+\.\d+(?:\.\d+)?)$') { continue }
      $candidates += [pscustomobject]@{ Version = [version]$Matches[1]; Release = $release }
    }
    $latest = $candidates | Sort-Object Version -Descending | Select-Object -First 1
    if (-not $latest) { throw 'GitHub 没有可用的版本发布。' }
    if ($latest.Version -le [version]$installed.version) {
      Write-Output "已是最新版本：$($installed.version)。词典和设置保持原样。"
      if ($RegisterDailyTask -and -not $DryRun) { Register-UpdateTask -Directory $root -DailyTime $At }
      return
    }
    $expectedReleaseVersion = [string]$latest.Version
    $assets = @($latest.Release.assets)
    $zipAsset = $assets | Where-Object { $_.name -match '^babel-tower-backtranslation-.*\.zip$' } | Select-Object -First 1
    if (-not $zipAsset) { throw '该版本缺少扩展 ZIP。' }
    $shaAsset = $assets | Where-Object { $_.name -eq ($zipAsset.name + '.sha256') } | Select-Object -First 1
    if (-not $shaAsset) { throw '该版本缺少 SHA-256 校验文件，拒绝更新。' }
    $zipPath = Join-Path $work $zipAsset.name
    $checksumPath = Join-Path $work $shaAsset.name
    Invoke-WebRequest -Uri $zipAsset.browser_download_url -Headers $headers -OutFile $zipPath -UseBasicParsing
    Invoke-WebRequest -Uri $shaAsset.browser_download_url -Headers $headers -OutFile $checksumPath -UseBasicParsing
  }

  $checksumText = Get-Content -LiteralPath $checksumPath -Raw -Encoding UTF8
  $expectedHash = [regex]::Match($checksumText, '(?i)\b[a-f0-9]{64}\b').Value
  if (-not $expectedHash) { throw 'SHA-256 校验文件格式有误，拒绝更新。' }
  $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
  if ($actualHash -ine $expectedHash) { throw '扩展 ZIP 的 SHA-256 不匹配，拒绝更新。' }

  $expanded = Join-Path $work 'expanded'
  Expand-Archive -LiteralPath $zipPath -DestinationPath $expanded
  $manifests = @(Get-ChildItem -LiteralPath $expanded -Filter manifest.json -File -Recurse)
  if ($manifests.Count -ne 1) { throw 'ZIP 必须恰好包含一个 manifest.json。' }
  $payloadRoot = $manifests[0].Directory.FullName
  $incoming = Get-Content -LiteralPath $manifests[0].FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($incoming.manifest_version -ne 3 -or $incoming.name -notmatch '巴别塔') { throw 'ZIP 不是预期的扩展。' }
  if ($expectedReleaseVersion -and [version]$incoming.version -ne [version]$expectedReleaseVersion) {
    throw 'GitHub 发布版本与 ZIP manifest 版本不一致。'
  }
  if ([version]$incoming.version -le [version]$installed.version) {
    Write-Output "安装目录版本 $($installed.version) 已不低于 ZIP 版本 $($incoming.version)，未覆盖文件。"
    if ($RegisterDailyTask -and -not $DryRun) { Register-UpdateTask -Directory $root -DailyTime $At }
    return
  }
  $markerPath = Join-Path $payloadRoot 'update-marker.json'
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { throw 'ZIP 缺少完成标记，拒绝更新。' }
  $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.ready -ne $true -or [version]$marker.version -ne [version]$incoming.version) {
    throw 'ZIP 的完成标记与 manifest 不一致，拒绝更新。'
  }

  $rootFiles = @('README.md', 'manifest.json', 'background.js', 'content.js', 'content.css',
    'popup.html', 'popup.js', 'popup.css', 'shared.js', 'writing.html', 'writing.js',
    'writing.css', 'update-unpacked.ps1', '安装与更新.md')
  $copyFiles = @()
  foreach ($name in $rootFiles) {
    $source = Join-Path $payloadRoot $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "ZIP 缺少文件：$name" }
    $copyFiles += [pscustomobject]@{ Source = $source; Relative = $name }
  }
  foreach ($directory in @('mdx', 'modules', 'sidebar')) {
    $sourceDir = Join-Path $payloadRoot $directory
    if (-not (Test-Path -LiteralPath $sourceDir -PathType Container)) { throw "ZIP 缺少目录：$directory" }
    foreach ($file in Get-ChildItem -LiteralPath $sourceDir -File -Recurse) {
      $copyFiles += [pscustomobject]@{ Source = $file.FullName; Relative = $file.FullName.Substring($payloadRoot.Length).TrimStart('\') }
    }
  }
  Write-Output "发现新版 $($incoming.version)，已验证 ZIP 哈希和 $($copyFiles.Count) 个运行文件。"
  if ($DryRun) {
    Write-Output 'DryRun：没有修改安装目录，也没有注册每日任务。'
    return
  }

  # Only runtime files are copied. Browser-profile storage and IndexedDB are never touched.
  # Keep manifest and marker until the end so the running worker sees a complete bundle.
  $ordinary = @($copyFiles | Where-Object { $_.Relative -ne 'manifest.json' })
  foreach ($item in $ordinary) {
    $destination = [System.IO.Path]::GetFullPath((Join-Path $root $item.Relative))
    if (-not $destination.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝写入安装目录之外：$destination"
    }
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Copy-Item -LiteralPath $item.Source -Destination $destination -Force
  }
  Copy-Item -LiteralPath (Join-Path $payloadRoot 'manifest.json') -Destination (Join-Path $root 'manifest.json') -Force
  foreach ($item in $copyFiles) {
    $destination = Join-Path $root $item.Relative
    if ((Get-FileHash -LiteralPath $item.Source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash) {
      throw "复制后校验失败：$($item.Relative)。完成标记尚未写入，浏览器不会自动重新加载。"
    }
  }
  Copy-Item -LiteralPath $markerPath -Destination (Join-Path $root 'update-marker.json') -Force
  Write-Output "已原目录更新到 $($incoming.version)。浏览器将在所有 X 标签页关闭后自动重新加载；从 0.2.2 或更早版本升级，首次仍需在扩展页手动点一次『重新加载』。"
  if ($RegisterDailyTask) { Register-UpdateTask -Directory $root -DailyTime $At }
} finally {
  $fullWork = [System.IO.Path]::GetFullPath($work)
  if ($fullWork.StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $fullWork)) {
    Remove-Item -LiteralPath $fullWork -Recurse -Force
  }
}
