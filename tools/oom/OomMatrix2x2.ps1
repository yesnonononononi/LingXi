[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$H2NewJar,
    [Parameter(Mandatory = $true)][string]$H2OldJar,
    [Parameter(Mandatory = $true)][string]$Fixtures,
    [Parameter(Mandatory = $true)][string]$RunRoot,
    [Parameter(Mandatory = $true)][string]$PositiveSample,
    [Parameter(Mandatory = $true)][string]$NegativeSample,
    [int]$Repeat = 2,
    [int]$Rounds = 30,
    [int]$Pause = 500,
    [int]$ContextEvery = 5
)

# ============================================================================
# 2×2 定位矩阵 + 并发矩阵驱动器
#
#   主矩阵：{H2 2.3.232, H2 2.5.252} × {整段 VARCHAR, 文件检查点 + CLOB}
#           × {pre, reconstructed} × {512, 1024} MiB，每格 ≥2 次
#   并发矩阵：{2.5.252 + 文件检查点, 2.3.232 + 整段 VARCHAR} × 512 MiB
#           × recovered × workers={1(串行对照), 3(真并发)}，每格 ≥2 次
#
# 每组独立 JVM + 独立临时目录（2.3.232 与 2.5.252 的 MVStore 互不兼容，绝不复用目录）。
# ============================================================================

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$matrixScript = Join-Path $PSScriptRoot 'OomReplayMatrix.ps1'
$scannerSource = Join-Path $PSScriptRoot 'OomScan.java'
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$runRootFull = [System.IO.Path]::GetFullPath($RunRoot)

foreach ($path in @($H2NewJar, $H2OldJar, $Fixtures, $matrixScript, $scannerSource, $PositiveSample, $NegativeSample)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "缺少必需文件: $path" }
}
if (-not $runRootFull.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "RunRoot 必须在系统临时目录下: $runRootFull"
}
if (Test-Path -LiteralPath $runRootFull) { throw "RunRoot 必须是全新目录: $runRootFull" }
New-Item -ItemType Directory -Path $runRootFull -Force | Out-Null

function Get-JarVersion([string]$jar) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($jar)
    try {
        $entry = $zip.GetEntry('META-INF/MANIFEST.MF')
        $reader = New-Object System.IO.StreamReader($entry.Open())
        $manifest = $reader.ReadToEnd()
        $reader.Close()
    } finally { $zip.Dispose() }
    $line = ($manifest -split "`n" | Where-Object { $_ -like 'Implementation-Version*' } | Select-Object -First 1)
    return $line.Trim().Replace('Implementation-Version:', '').Trim()
}

$newVersion = Get-JarVersion $H2NewJar
$oldVersion = Get-JarVersion $H2OldJar
$newHash = (Get-FileHash -Algorithm SHA256 $H2NewJar).Hash.ToLower()
$oldHash = (Get-FileHash -Algorithm SHA256 $H2OldJar).Hash.ToLower()
Write-Host "H2 新版: $newVersion sha256=$newHash"
Write-Host "H2 旧版: $oldVersion sha256=$oldHash"

# --- 1. 扫描器自检（先行，顺序不可颠倒） ---------------------------------
$tools = Join-Path $runRootFull '_tools'
New-Item -ItemType Directory -Path $tools -Force | Out-Null
& javac -encoding UTF-8 -d $tools $scannerSource
if ($LASTEXITCODE -ne 0) { throw '扫描器编译失败' }
$selfCheckLog = New-Object System.Collections.Generic.List[string]
function Invoke-SelfCheckScan([string]$label, [string[]]$paths) {
    $scanArgs = @('--class-path', $tools, 'OomScan')
    foreach ($p in $paths) { $scanArgs += "--file=$p" }
    $out = & java @scanArgs 2>&1
    $line = ($out | Where-Object { $_ -like 'SCAN verdict=*' } | Select-Object -Last 1)
    $verdict = if ($line -match 'verdict=(\w+)') { $matches[1] } else { 'UNKNOWN' }
    $script:selfCheckLog.Add("$label -> $line")
    Write-Host "$label -> $verdict"
    return $verdict
}
$tricky = Join-Path $runRootFull 'selfcheck-tricky-negative.log'
@('RESULT ... oom=false, failure=none', '本组结论：无 OOM', '已知含 OOM 的历史日志必须判 OOM')
    | Set-Content -LiteralPath $tricky -Encoding utf8
$posVerdict = Invoke-SelfCheckScan '正样本(历史 h2 OOM 日志)' @($PositiveSample)
$negVerdict = Invoke-SelfCheckScan '负样本(历史 sqlite 正常日志)' @($NegativeSample)
$trickyVerdict = Invoke-SelfCheckScan '负样本(结论文案陷阱)' @($tricky)
$selfCheckOk = ($posVerdict -eq 'OOM') -and ($negVerdict -eq 'CLEAN') -and ($trickyVerdict -eq 'CLEAN')
if (-not $selfCheckOk) {
    $selfCheckLog | Set-Content -LiteralPath (Join-Path $runRootFull 'scanner-selfcheck.log') -Encoding utf8
    throw '扫描器自检未通过：本轮禁止给出任何「无 OOM」结论'
}
Write-Host '扫描器自检通过（正样本→OOM，两个负样本→CLEAN）'

# --- 2. 主矩阵 -----------------------------------------------------------
$versions = @(
    @{ label = "h2-$newVersion"; jar = $H2NewJar },
    @{ label = "h2-$oldVersion"; jar = $H2OldJar }
)
$modes = @('varchar', 'file')
$matrixRuns = New-Object System.Collections.Generic.List[object]
foreach ($version in $versions) {
    foreach ($mode in $modes) {
        $group = "$($version.label)-$mode"
        # 每组一个全新 RunRoot：矩阵脚本拒绝复用目录（2.3.232 与 2.5.252 的 MVStore 互不兼容）。
        $groupRoot = Join-Path (Join-Path $runRootFull 'main') $group
        Write-Host "=== 主矩阵 $group ==="
        & pwsh -NoProfile -File $matrixScript -H2Jar $version.jar -Fixtures $Fixtures `
            -RunRoot $groupRoot -Heaps '512,1024' -Scenarios 'pre,reconstructed' `
            -Mode $mode -GroupName $group -Rounds $Rounds -Pause $Pause -ContextEvery $ContextEvery `
            -Workers 1 -Repeat $Repeat
        $json = Join-Path $groupRoot "matrix-$group.json"
        $matrixRuns.Add([pscustomobject]@{ group = $group; kind = 'main'; json = $json; md = $json.Replace('.json', '.md') })
    }
}

# --- 3. 并发矩阵（含串行对照） -------------------------------------------
$concurrencyCombos = @(
    @{ label = "h2-$newVersion-file"; jar = $H2NewJar; mode = 'file' },
    @{ label = "h2-$oldVersion-varchar"; jar = $H2OldJar; mode = 'varchar' }
)
foreach ($combo in $concurrencyCombos) {
    foreach ($arm in @(@{ workers = 3; suffix = 'conc3' }, @{ workers = 1; suffix = 'serial' })) {
        $group = "$($combo.label)-$($arm.suffix)"
        $groupRoot = Join-Path (Join-Path $runRootFull 'concurrency') $group
        Write-Host "=== 并发矩阵 $group (workers=$($arm.workers)) ==="
        & pwsh -NoProfile -File $matrixScript -H2Jar $combo.jar -Fixtures $Fixtures `
            -RunRoot $groupRoot -Heaps '512' -Scenarios 'recovered' `
            -Mode $combo.mode -GroupName $group -Rounds $Rounds -Pause $Pause -ContextEvery $ContextEvery `
            -Workers $arm.workers -Repeat $Repeat
        $json = Join-Path $groupRoot "matrix-$group.json"
        $matrixRuns.Add([pscustomobject]@{ group = $group; kind = $arm.suffix; json = $json; md = $json.Replace('.json', '.md') })
    }
}

# --- 4. 汇总 -------------------------------------------------------------
$allRows = New-Object System.Collections.Generic.List[string]
$allDetails = New-Object System.Collections.Generic.List[object]
foreach ($run in $matrixRuns) {
    if (-not (Test-Path -LiteralPath $run.json)) { throw "缺少矩阵结果: $($run.json)" }
    $details = Get-Content -LiteralPath $run.json -Raw | ConvertFrom-Json
    foreach ($row in $details) {
        $row | Add-Member -NotePropertyName kind -NotePropertyValue $run.kind -Force
        $allDetails.Add($row)
    }
    Get-Content -LiteralPath $run.md | Where-Object { $_ -like '| *' } | ForEach-Object { $allRows.Add($_) }
}

$out = Join-Path $runRootFull 'matrix-2x2-all.md'
$header = @(
    '# OOM 2×2 + 并发矩阵原始数据（自动生成）',
    '',
    "- H2 新版: $newVersion sha256=$newHash",
    "- H2 旧版: $oldVersion sha256=$oldHash",
    "- 每格重复次数: $Repeat；rounds=$Rounds；pause=$Pause ms；contextEvery=$ContextEvery（reconstructed 每轮）",
    '',
    '## 扫描器自检',
    ''
)
$selfCheckLog | ForEach-Object { $header += "- $_" }
$header += ''
$header += '## 数据表'
$header += ''
$header += $allRows
Set-Content -LiteralPath $out -Value ($header -join "`n") -Encoding utf8
$allDetails | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runRootFull 'matrix-2x2-all.json') -Encoding utf8

# --- 5. 机读判定提示（最终结论由报告正文给出） ---------------------------
Write-Host ''
Write-Host '=== 判定输入摘要（每组取最坏一次） ==='
$groups = $allDetails | Group-Object group
foreach ($group in $groups) {
    $worst = $group.Group | Sort-Object { if ($_.scanVerdict -eq 'OOM') { 0 } elseif ($_.failure -ne 'none') { 1 } else { 2 } } | Select-Object -First 1
    $peaks = ($group.Group | ForEach-Object { [double]$_.peakHeapMiB } | Measure-Object -Maximum).Maximum
    $liveEnds = ($group.Group | ForEach-Object { [double]$_.liveEndMiB } | Measure-Object -Maximum).Maximum
    Write-Host ("{0}: 最坏扫描器={1} 最坏类别={2} 峰值max={3}MiB 存活量max={4}MiB" -f `
            $group.Name, $worst.scanVerdict, $worst.failure, $peaks, $liveEnds)
}
Write-Host ''
Write-Host "汇总数据: $out"
exit 0
