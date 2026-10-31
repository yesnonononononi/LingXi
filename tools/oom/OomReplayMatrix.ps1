[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$H2Jar,
    [Parameter(Mandatory = $true)][string]$Fixtures,
    [Parameter(Mandatory = $true)][string]$RunRoot,
    [string]$Ddl = '',
    [string[]]$Heaps = @('512', '1024'),
    [string[]]$Scenarios = @('pre', 'recovered', 'reconstructed'),
    [ValidateSet('file', 'varchar')][string]$Mode = 'file',
    [string]$GroupName = 'h2-new',
    [int]$Rounds = 30,
    [int]$Pause = 500,
    [int]$ContextEvery = 5,
    [int]$Workers = 1
)

# ============================================================================
# OOM 回归矩阵编排（T05 单元 E，§附录E.1 / E.2）
#
# 每一组 = 独立 JVM + 独立隔离目录 + 10ms 堆采样 + 100ms 工作集采样 + GC 日志。
# 判据不是退出码：退出码只记录，结论由「扫描器文本判定 + 数据表」给出。
# 运行时产物一律落在 -RunRoot（必须在系统临时目录下），不进仓库工作区。
# ============================================================================

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# pwsh -File 会把 "512,1024" 当成一个字符串传进来，这里统一规范化成数组，
# 否则矩阵会被当成「单组 + 堆档名 5121024」跑，数据表直接失真。
$Heaps = @($Heaps | ForEach-Object { "$_" -split ',' } | Where-Object { $_ -ne '' } | ForEach-Object { [int]$_ })
$Scenarios = @($Scenarios | ForEach-Object { "$_" -split ',' } | Where-Object { $_ -ne '' })

$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if ([string]::IsNullOrWhiteSpace($Ddl)) {
    $Ddl = Join-Path $repo 'src\main\resources\db\h2\V1__schema.sql'
}
$replaySource = Join-Path $repo 'tools\oom\CheckpointReplay.java'
$scannerSource = Join-Path $repo 'tools\oom\OomScan.java'
$analyzerSource = Join-Path $repo 'tools\oom\AnalyzeHeap.java'

foreach ($required in @($H2Jar, $Fixtures, $Ddl, $replaySource, $scannerSource, $analyzerSource)) {
    $candidate = "$required"
    if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path -LiteralPath $candidate)) {
        throw "缺少必需文件: $candidate"
    }
}

# 隔离：运行根必须在系统临时目录下（禁区：工作区、~/.lingxi、.lingxi/development）
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$runRootFull = [System.IO.Path]::GetFullPath($RunRoot)
if (-not $runRootFull.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "RunRoot 必须在系统临时目录下: $runRootFull"
}
if (Test-Path -LiteralPath $runRootFull) {
    throw "RunRoot 必须是全新目录（不允许复用旧库）: $runRootFull"
}
New-Item -ItemType Directory -Path $runRootFull -Force | Out-Null

# 编译器单独运行，避免源码启动器的编译对象混入受限堆峰值。
$classes = Join-Path $runRootFull 'classes'
New-Item -ItemType Directory -Path $classes | Out-Null
& javac -encoding UTF-8 -d $classes $replaySource $scannerSource $analyzerSource
if ($LASTEXITCODE -ne 0) { throw 'OOM 重放工具编译失败，拒绝继续测量' }
$toolClassPath = $classes + [System.IO.Path]::PathSeparator + $H2Jar

$scenarioRounds = @{ 'pre' = $Rounds; 'recovered' = $Rounds; 'reconstructed' = $Rounds }
$rows = New-Object System.Collections.Generic.List[string]
$details = New-Object System.Collections.Generic.List[object]

foreach ($scenario in $Scenarios) {
    foreach ($heap in $Heaps) {
        $label = "$GroupName/$scenario-$heap"
        $groupDir = Join-Path (Join-Path $runRootFull $GroupName) (Join-Path $scenario "$heap")
        $dataDir = Join-Path $groupDir 'data'
        New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
        $console = Join-Path $groupDir 'console.log'
        $stderr = Join-Path $groupDir 'stderr.log'
        $gcLog = Join-Path $groupDir 'gc.log'

        $heapArg = "-Xmx${heap}m"
        # 场景定义按历史记录：reconstructed 每轮更新上下文，pre / recovered 每 5 轮更新一次。
        $ctxEvery = if ($scenario -eq 'reconstructed') { 1 } else { $ContextEvery }
        $gcArg = '-Xlog:gc*:file="{0}":time,uptime,level,tags' -f $gcLog
        $javaArgs = @(
            '-Xms128m', $heapArg, $gcArg,
            '--class-path', ('"{0}"' -f $toolClassPath),
            'CheckpointReplay',
            "--mode=$Mode",
            "--scenario=$scenario",
            "--out=$groupDir",
            "--fixtures=$Fixtures",
            "--ddl=$Ddl",
            "--rounds=$($scenarioRounds[$scenario])",
            "--pause=$Pause",
            "--contextEvery=$ctxEvery",
            "--workers=$Workers"
        )

        Write-Host "=== 运行 $label (mode=$Mode, heap=${heap}MiB) ==="
        $started = Get-Date
        $process = Start-Process -FilePath 'java' -ArgumentList $javaArgs -PassThru -NoNewWindow `
            -RedirectStandardOutput $console -RedirectStandardError $stderr
        $workingSet = New-Object System.Collections.Generic.List[string]
        $workingSet.Add('millis,workingSetBytes')
        $watch = [System.Diagnostics.Stopwatch]::StartNew()
        while (-not $process.HasExited) {
            try {
                $live = Get-Process -Id $process.Id -ErrorAction Stop
                $workingSet.Add(('{0},{1}' -f $watch.ElapsedMilliseconds, $live.WorkingSet64))
            } catch {
                # 进程刚退出时 Get-Process 会失败，正常现象。
            }
            Start-Sleep -Milliseconds 100
        }
        $process.WaitForExit()
        $watch.Stop()
        $exitCode = $process.ExitCode
        Set-Content -LiteralPath (Join-Path $groupDir 'ws.csv') -Value $workingSet -Encoding UTF8

        # 扫描器：控制台 / 标准错误 / H2 trace 全扫；判据是它的结论，不是退出码。
        $scanOutput = & java --class-path $toolClassPath OomScan "--dir=$groupDir" 2>&1
        $scanOutput | Set-Content -LiteralPath (Join-Path $groupDir 'scan.log') -Encoding UTF8
        $scanLine = ($scanOutput | Where-Object { $_ -like 'SCAN verdict=*' } | Select-Object -Last 1)
        $verdict = 'UNKNOWN'
        if ($scanLine -match 'verdict=(\w+)') { $verdict = $matches[1] }
        $hitLines = 0
        if ($scanLine -match 'hitLines=(\d+)') { $hitLines = [int]$matches[1] }

        $row = (& java --class-path $toolClassPath AnalyzeHeap "--group=$GroupName" "--scenario=$scenario" `
                "--heap=$heap" "--dir=$groupDir" 2>&1 | Out-String).Trim()
        $rows.Add("$row`t$verdict`t$exitCode")
        Write-Host ("结论: 扫描器={0} 命中行={1} 退出码={2}" -f $verdict, $hitLines, $exitCode)

        $resultLine = ''
        if (Test-Path -LiteralPath $console) {
            $resultLine = (Get-Content -LiteralPath $console -Tail 60 | Where-Object { $_ -like 'RESULT *' } | Select-Object -Last 1)
        }
        $rowCells = $row -split "`t"
        $details.Add([pscustomobject]@{
                group         = $GroupName
                mode          = $Mode
                scenario      = $scenario
                heapMiB       = $heap
                peakHeapMiB   = [double]$rowCells[3]
                peakPercent   = $rowCells[4]
                fullGc        = $rowCells[5]
                maxPauseMs    = $rowCells[6]
                workingSetMiB = $rowCells[7]
                throughput    = $rowCells[8]
                elapsedSecond = $rowCells[9]
                failure       = $rowCells[11]
                exitCode      = $exitCode
                scanVerdict   = $verdict
                scanHitLines  = $hitLines
                scanLine      = $scanLine
                result        = $resultLine
                startedAt     = $started.ToString('o')
                groupDir      = $groupDir
                wallClockSec  = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
            })
    }
}

$summaryPath = Join-Path $runRootFull ('matrix-{0}.md' -f $GroupName)
$header = @(
    "| 组 | 场景 | 堆档(MiB) | 峰值堆(MiB) | 占 Xmx% | Full GC 次数 | 最长停顿(ms) | 工作集峰值(MiB) | 保存吞吐(次/s) | 总耗时(s) | GC 次数 | 失败类别 | 扫描器结论 | 退出码 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
)
$body = foreach ($row in $rows) {
    $cells = $row -split "`t"
    "| " + ($cells -join " | ") + " |"
}
Set-Content -LiteralPath $summaryPath -Value ($header + $body) -Encoding UTF8
$details | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runRootFull ('matrix-{0}.json' -f $GroupName)) -Encoding UTF8

Write-Host ''
Write-Host "数据表: $summaryPath"
$header + $body | ForEach-Object { Write-Host $_ }
