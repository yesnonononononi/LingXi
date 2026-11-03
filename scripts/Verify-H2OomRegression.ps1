[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$H2Jar,
    [Parameter(Mandatory = $true)][string]$Fixtures,
    [Parameter(Mandatory = $true)][string]$RunRoot,
    [Parameter(Mandatory = $true)][string]$PositiveSample,
    [Parameter(Mandatory = $true)][string]$NegativeSample,
    [string[]]$Heaps = @('512', '1024'),
    [string[]]$Scenarios = @('pre', 'recovered', 'reconstructed'),
    [int]$Rounds = 30,
    [int]$Pause = 500,
    [int]$ContextEvery = 5,
    [int]$Workers = 1
)

# ============================================================================
# OOM 事故回归门禁（T05 单元 E，设计 §附录E）。
#
# 顺序不可颠倒：
#   1) 环境校验（H2 版本 / 隔离目录）
#   2) 扫描器自检：正样本必须判「有 OOM」、负样本必须判「无 OOM」——不通过就拒绝给结论
#   3) h2-new 矩阵：H2 2.5.252 + 文件检查点 + CLOB
#   4) 正对照变异：整段 VARCHAR（旧事故形态）必须复现 OOM 或显著内存放大
#   5) 汇总：数据表 + 三档结论
# 任一步不成立即非 0 退出；不允许用「调小堆 / 缩短场景」凑绿。
# ============================================================================

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# pwsh -File 把 "512,1024" 当单个字符串送进来，这里规范化成数组。
$Heaps = @($Heaps | ForEach-Object { "$_" -split ',' } | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
$Scenarios = @($Scenarios | ForEach-Object { "$_" -split ',' } | Where-Object { $_ -ne '' })

$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scannerSource = Join-Path $repo 'tools\oom\OomScan.java'
$matrixScript = Join-Path $repo 'tools\oom\OomReplayMatrix.ps1'
$scannerLog = New-Object System.Collections.Generic.List[string]
$gateFailures = New-Object System.Collections.Generic.List[string]

function Invoke-Scan {
    param([string]$Label, [string[]]$Paths)
    $scanArgs = @('--class-path', $H2Jar, $scannerSource)
    foreach ($path in $Paths) { $scanArgs += "--file=$path" }
    $output = & java @scanArgs 2>&1
    $line = ($output | Where-Object { $_ -like 'SCAN verdict=*' } | Select-Object -Last 1)
    $verdict = 'UNKNOWN'
    if ($line -match 'verdict=(\w+)') { $verdict = $matches[1] }
    $scannerLog.Add("$Label -> $line")
    Write-Host "扫描器自检[$Label]: $line"
    return $verdict
}

# --- 1. 环境校验 -----------------------------------------------------------
Write-Host '=== 1. 环境校验 ==='
foreach ($path in @($H2Jar, $Fixtures, $PositiveSample, $NegativeSample, $scannerSource, $matrixScript)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "缺少必需文件: $path" }
}
$manifest = (& { Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($H2Jar)
        try {
            $entry = $zip.GetEntry('META-INF/MANIFEST.MF')
            $reader = New-Object System.IO.StreamReader($entry.Open())
            $reader.ReadToEnd()
            $reader.Close()
        } finally { $zip.Dispose() }
    })
if ($manifest -notmatch 'Implementation-Version:\s*2\.5\.252') {
    throw "H2 jar 版本不是 2.5.252（门禁只认本设计固定的版本）: $H2Jar"
}
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$runRootFull = [System.IO.Path]::GetFullPath($RunRoot)
if (-not $runRootFull.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "RunRoot 必须在系统临时目录下（禁区零写入）: $runRootFull"
}
Write-Host "H2 jar: $H2Jar"
Write-Host "隔离根: $runRootFull"

# --- 2. 扫描器自检（先行，不可颠倒） --------------------------------------
Write-Host '=== 2. 扫描器自检 ==='
$positiveVerdict = Invoke-Scan -Label '正样本(历史 h2 OOM 日志)' -Paths @($PositiveSample)
if ($positiveVerdict -ne 'OOM') {
    $gateFailures.Add("扫描器正样本未判出 OOM（verdict=$positiveVerdict）：自检不通过，本轮禁止给「无 OOM」结论")
}
$negativeVerdict = Invoke-Scan -Label '负样本(历史 sqlite 正常日志)' -Paths @($NegativeSample)
if ($negativeVerdict -ne 'CLEAN') {
    $gateFailures.Add("扫描器负样本误判为 OOM（verdict=$negativeVerdict）")
}
# 结论文案不能被当证据：造一个只含「oom=false / 无 OOM」的文本喂进去。
$trickyNegative = Join-Path $runRootFull 'selfcheck-tricky-negative.log'
New-Item -ItemType Directory -Path $runRootFull -Force | Out-Null
@(
    'RESULT engine=h2, scenario=pre, heapMiB=512, peakHeapMiB=160, oom=false, failure=none',
    '本组结论：无 OOM（扫描器判 CLEAN）',
    '扫描器自检说明：已知含 OOM 的历史日志必须判 OOM，正常输出必须判 CLEAN'
) | Set-Content -LiteralPath $trickyNegative -Encoding utf8
$trickyVerdict = Invoke-Scan -Label '负样本(结论文案陷阱)' -Paths @($trickyNegative)
if ($trickyVerdict -ne 'CLEAN') {
    $gateFailures.Add("扫描器把结论文案当成了 OOM 证据（verdict=$trickyVerdict）")
}
if ($gateFailures.Count -gt 0) {
    Write-Host '扫描器自检未通过，拒绝继续给出 OOM 结论。'
    $scannerLog | Set-Content -LiteralPath (Join-Path $runRootFull 'scanner-selfcheck.log') -Encoding utf8
    exit 2
}
Write-Host '扫描器自检通过（正样本→OOM，负样本→CLEAN）。'

# --- 3. h2-new 矩阵（本轮主证据） ----------------------------------------
Write-Host '=== 3. h2-new 矩阵 ==='
$newRoot = Join-Path $runRootFull 'run-h2-new'
& pwsh -NoProfile -File $matrixScript -H2Jar $H2Jar -Fixtures $Fixtures -RunRoot $newRoot `
    -Heaps ($Heaps -join ',') -Scenarios ($Scenarios -join ',') -Mode file -GroupName 'h2-new' `
    -Rounds $Rounds -Pause $Pause -ContextEvery $ContextEvery -Workers $Workers
$newResults = Get-Content -LiteralPath (Join-Path $newRoot 'matrix-h2-new.json') -Raw | ConvertFrom-Json

foreach ($result in $newResults) {
    if ($result.scanVerdict -ne 'CLEAN') {
        $gateFailures.Add("h2-new $($result.scenario)/$($result.heapMiB)MiB 扫描器判 $($result.scanVerdict)")
    }
    if ($result.result -notmatch 'failure=none') {
        $gateFailures.Add("h2-new $($result.scenario)/$($result.heapMiB)MiB 存在失败: $($result.result)")
    }
}

# --- 4. 正对照变异（必须能变红） -----------------------------------------
Write-Host '=== 4. 正对照变异（整段 VARCHAR） ==='
$controlRoot = Join-Path $runRootFull 'run-positive-control'
& pwsh -NoProfile -File $matrixScript -H2Jar $H2Jar -Fixtures $Fixtures -RunRoot $controlRoot `
    -Heaps '512' -Scenarios 'reconstructed,pre' -Mode varchar -GroupName 'positive-control' `
    -Rounds $Rounds -Pause $Pause -ContextEvery $ContextEvery -Workers $Workers
$controlResults = Get-Content -LiteralPath (Join-Path $controlRoot 'matrix-positive-control.json') -Raw | ConvertFrom-Json

$controlRed = 0
foreach ($result in $controlResults) {
    $newTwin = $newResults | Where-Object { $_.scenario -eq $result.scenario -and $_.heapMiB -eq $result.heapMiB }
    $newPeak = 0.0
    if ($newTwin) { $newPeak = [double]$newTwin.peakHeapMiB }
    $controlPeak = [double]$result.peakHeapMiB
    $ratio = if ($newPeak -gt 0) { [math]::Round($controlPeak / $newPeak, 2) } else { 0 }
    $pct = [math]::Round($controlPeak / $result.heapMiB * 100, 1)
    $turnedRed = ($result.scanVerdict -eq 'OOM') -or ($pct -ge 85 -and $ratio -ge 2)
    if ($turnedRed) { $controlRed++ } else {
        $gateFailures.Add("正对照 $($result.scenario)/$($result.heapMiB)MiB 未变红（峰值 $controlPeak MiB = $pct% Xmx，相对 h2-new 同场景 ${ratio}x）：判定负载不足，本轮通过无效")
    }
    Write-Host ("正对照 {0}/{1}MiB: 峰值 {2} MiB ({3}% Xmx), 相对 h2-new {4}x, 扫描器={5}, 变红={6}" -f `
            $result.scenario, $result.heapMiB, $controlPeak, $pct, $ratio, $result.scanVerdict, $turnedRed)
}

# --- 5. 汇总 --------------------------------------------------------------
$verdict = if ($gateFailures.Count -eq 0) { 'PASS' } else { 'FAIL' }
$report = Join-Path $runRootFull 'oom-gate-summary.md'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# OOM 事故回归门禁汇总（自动生成）')
$lines.Add('')
$lines.Add("生成时间: $(Get-Date -Format o)")
$lines.Add("门禁结论: $verdict")
$lines.Add('')
$lines.Add('## 扫描器自检')
$lines.Add('')
$scannerLog | ForEach-Object { $lines.Add("- $_") }
$lines.Add('')
$lines.Add('## h2-new 数据表')
$lines.Add('')
$lines.Add((Get-Content -LiteralPath (Join-Path $newRoot 'matrix-h2-new.md')) -join "`n")
$lines.Add('')
$lines.Add('## positive-control 数据表')
$lines.Add('')
$lines.Add((Get-Content -LiteralPath (Join-Path $controlRoot 'matrix-positive-control.md')) -join "`n")
$lines.Add('')
$lines.Add('## 门禁问题')
$lines.Add('')
if ($gateFailures.Count -eq 0) { $lines.Add('- 无') } else { $gateFailures | ForEach-Object { $lines.Add("- $_") } }
$lines | Set-Content -LiteralPath $report -Encoding utf8
Write-Host ''
Write-Host "汇总: $report"
Write-Host "门禁结论: $verdict"
if ($gateFailures.Count -gt 0) {
    $gateFailures | ForEach-Object { Write-Host " - $_" }
    exit 1
}
exit 0
