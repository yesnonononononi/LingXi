[CmdletBinding()]
param(
    [string[]]$Only = @(),
    [string]$LogRoot = (Join-Path ([System.IO.Path]::GetTempPath()) 'lingxi-qa-mutations')
)

# ============================================================================
# 变异门禁执行器（T05 P1，设计 §附录D.2 的 M1–M16；M17 是 OOM 正对照，由
# scripts/Verify-H2OomRegression.ps1 执行）。
#
# 每条变异 = 改一处 → 跑指定用例 → 必须变红 → git 还原 → 复核文件已回原样。
# 变异只允许临时存在：跑完立刻 git checkout，仓库不留任何变异痕（不提交）。
#
# 用法：
#   pwsh -NoProfile -File tools/qa/Run-MutationGate.ps1            # 全部
#   pwsh -NoProfile -File tools/qa/Run-MutationGate.ps1 -Only M2,M5
# ============================================================================

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$utf8 = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $LogRoot)) {
    New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
}

$Ddl = 'src/main/resources/db/h2/V1__schema.sql'
$Initializer = 'src/main/java/com/summit/dp/shared/config/H2SchemaInitializer.java'
$Guard = 'src/main/java/com/summit/dp/shared/storage/StorageEngineGuard.java'
$MybatisConfig = 'src/main/java/com/summit/dp/shared/config/MybatisPlusConfig.java'
$DataSourceKeys = 'src/main/java/com/summit/dp/shared/storage/StorageDataSourceKeys.java'
$LargeText = 'src/main/java/com/summit/dp/shared/persistence/handler/LargeTextTypeHandler.java'

$mutations = @(
    @{ id = 'M1'; file = $Ddl; note = 'session_context.content 改回 VARCHAR(1000000000)'; tests = 'H2SchemaPoConsistencyTest,H2TypeHandlerRoundTripTest'; steps = @(
            @{ p = '(?s)(CREATE TABLE IF NOT EXISTS session_context \(\s*session_id\s+BIGINT PRIMARY KEY,\s*content\s+)CLOB'; r = '${1}VARCHAR(1000000000)' }) }
    @{ id = 'M2'; file = $Ddl; note = '删除 uk_checklist_active_session'; tests = 'H2ConcurrencyArbitrationTest'; steps = @(
            @{ p = '(?m)^CREATE UNIQUE INDEX IF NOT EXISTS uk_checklist_active_session[^\r\n]*\r?\n'; r = '' }) }
    @{ id = 'M3'; file = $Ddl; note = '删除 uk_resume_task_generation'; tests = 'H2ConcurrencyArbitrationTest'; steps = @(
            @{ p = '(?m)^CREATE UNIQUE INDEX IF NOT EXISTS uk_resume_task_generation[^\r\n]*\r?\n'; r = '' }) }
    @{ id = 'M4'; file = $Ddl; note = '删除 uk_session_response_id 与 uk_email_message_dedup'; tests = 'H2ConcurrencyArbitrationTest,EmailCrudServiceTest'; steps = @(
            @{ p = '(?m)^CREATE UNIQUE INDEX IF NOT EXISTS uk_session_response_id[^\r\n]*\r?\n'; r = '' },
            @{ p = '(?m)^CREATE UNIQUE INDEX IF NOT EXISTS uk_email_message_dedup[^\r\n]*\r?\n'; r = '' }) }
    @{ id = 'M5'; file = $MybatisConfig; note = '分页 DbType 写死 SQLITE'; tests = 'MybatisPlusConfigTest'; steps = @(
            @{ p = 'DbType dbType = engine\.isH2\(\) \? DbType\.H2 : DbType\.SQLITE;'; r = 'DbType dbType = DbType.SQLITE;' }) }
    @{ id = 'M6'; file = $DataSourceKeys; note = '去掉 SET TIME ZONE ''UTC''（URL INIT）'; tests = 'H2TypeHandlerRoundTripTest,H2UtcSessionTimeZoneTest'; steps = @(
            @{ p = '\r?\n\s*\+ ";INIT=" \+ SET_TIME_ZONE_UTC'; r = '' }) }
    @{ id = 'M7'; file = $Initializer; note = '版本登记移到语句执行之前'; tests = 'H2SchemaMigrationTest'; steps = @(
            @{ p = '(?s)executeIdempotent\(connection, script\);\r?\n\s+verifyObjects\(connection, script\);\r?\n\s+verifyExpectedTables\(connection\);\r?\n\s+recordVersion\(connection, script\);'; r = "recordVersion(connection, script);`r`n                executeIdempotent(connection, script);`r`n                verifyObjects(connection, script);`r`n                verifyExpectedTables(connection);" }) }
    @{ id = 'M8'; file = $Initializer; note = '去掉 checksum 校验'; tests = 'H2SchemaMigrationTest'; steps = @(
            @{ p = 'if \(!appliedChecksum\.equalsIgnoreCase\(script\.checksum\(\)\)\) \{'; r = 'if (false) {' }) }
    @{ id = 'M9'; file = $Guard; note = 'engine=h2 + 只有 sqlite 数据也放行'; tests = 'StorageEngineGuardTest'; steps = @(
            @{ p = '(?s)if \(sqliteData && !h2Data\) \{\s*return StorageVerdict\.REJECT_SQLITE_DATA_WITHOUT_MIGRATION;'; r = 'if (sqliteData && !h2Data) { return StorageVerdict.READY;' }) }
    @{ id = 'M10'; file = $Guard; note = 'engine=sqlite + 只有 h2 库时静默建空库'; tests = 'StorageEngineGuardTest'; steps = @(
            @{ p = '(?s)if \(!sqliteData\) \{\s*return StorageVerdict\.REJECT_H2_DATA_WITH_SQLITE_ENGINE;'; r = 'if (!sqliteData) { return StorageVerdict.FIRST_INSTALL;' }) }
    @{ id = 'M14'; file = $LargeText; note = 'LargeTextTypeHandler 读侧截断 64 KiB'; tests = 'H2TypeHandlerRoundTripTest'; steps = @(
            @{ p = 'return rs\.getString\(columnName\);'; r = "String raw = rs.getString(columnName);`r`n        return raw == null || raw.length() <= 65536 ? raw : raw.substring(0, 65536);" }) }
    @{ id = 'M15'; file = $Ddl; note = 'session.context_ratio 改成 NUMERIC(6,4)'; tests = 'H2SchemaPoConsistencyTest'; steps = @(
            @{ p = '(context_ratio\s+)DOUBLE PRECISION'; r = '${1}NUMERIC(6,4)' }) }
    @{ id = 'M16'; file = $Guard; note = 'src/main 里新增 DriverManager.getConnection'; tests = 'StorageDriverPolicyTest'; steps = @(
            @{ p = '(?s)(public class StorageEngineGuard \{)'; r = "`$1`r`n`r`n    static void driverManagerProbe() throws java.sql.SQLException {`r`n        java.sql.DriverManager.getConnection(`"h2:probe`");`r`n    }`r`n" }) }
)

$selected = $mutations | Where-Object { $Only.Count -eq 0 -or $Only -contains $_.id }
$results = New-Object System.Collections.Generic.List[object]

foreach ($mutation in $selected) {
    $id = $mutation.id
    $full = Join-Path $repo $mutation.file
    $log = Join-Path $LogRoot ("$id.log")
    Write-Host "=== 变异 $id : $($mutation.note) ($($mutation.file)) ==="

    $original = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)
    $mutated = $original
    $anchorFailures = @()
    foreach ($step in $mutation.steps) {
        $count = ([regex]::Matches($mutated, $step.p)).Count
        if ($count -ne 1) { $anchorFailures += "$($step.p) 命中 $count 次" }
        $mutated = [regex]::Replace($mutated, $step.p, $step.r)
    }
    if ($anchorFailures.Count -gt 0) {
        Write-Host "ANCHOR_FAIL: $($anchorFailures -join '; ')"
        $results.Add([pscustomobject]@{ id = $id; note = $mutation.note; file = $mutation.file; tests = $mutation.tests; red = $false; status = 'ANCHOR_FAIL'; failedTests = ($anchorFailures -join '; '); message = ''; reverted = 'n/a'; log = '' })
        continue
    }
    [System.IO.File]::WriteAllText($full, $mutated, $utf8)

    Push-Location $repo
    try {
        & mvn -o -B "-DfailIfNoTests=false" "-Dtest=$($mutation.tests)" test 2>&1 | Out-File -FilePath $log -Encoding utf8
        $exit = $LASTEXITCODE
    } finally {
        & git checkout -- $mutation.file
        $dirty = (& git status --porcelain $mutation.file)
        Pop-Location
    }
    Start-Sleep -Milliseconds 200
    $restored = [System.IO.File]::ReadAllText($full, [System.Text.Encoding]::UTF8)
    $reverted = if ([string]::IsNullOrWhiteSpace($dirty) -and $restored -eq $original) { 'OK（文件逐字回原样）' } else { 'FAIL' }

    $content = Get-Content -LiteralPath $log
    $failures = @()
    foreach ($line in $content) {
        if ($line -match '^\[ERROR\]\s+(\S+Test\.\w+:\d+)\s+(.*)$') {
            $failures += ($matches[1] + ' ' + ($matches[2].Trim()))
        }
    }
    $summary = ($content | Select-String -Pattern '^\[(INFO|ERROR|WARNING)\] Tests run: \d+, Failures: \d+, Errors: \d+, Skipped: \d+$' | Select-Object -Last 1)
    $failedTestNames = ($failures | ForEach-Object { ($_ -split ' ')[0] }) -join ', '
    $message = ($failures | Select-Object -First 1)
    Write-Host ("退出码={0} 红={1} 失败用例={2}" -f $exit, ($exit -ne 0), $failedTestNames)

    $results.Add([pscustomobject]@{
            id          = $id
            note        = $mutation.note
            file        = $mutation.file
            tests       = $mutation.tests
            red         = ($exit -ne 0)
            status      = $(if ($exit -ne 0) { 'RED(通过)' } else { 'GREEN(未检出)' })
            failedTests = $failedTestNames
            message     = $message
            reverted    = $reverted
            log         = $log
        })
}

$jsonPath = Join-Path $LogRoot 'mutation-gate.json'
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $jsonPath -Encoding utf8

Write-Host ''
Write-Host '| 变异 | 变异点 | 用例 | 结果 | 变红用例 | 还原 |'
Write-Host '| --- | --- | --- | --- | --- | --- |'
foreach ($result in $results) {
    Write-Host ("| {0} | {1} | {2} | {3} | {4} | {5} |" -f $result.id, $result.note, $result.tests, $result.status, $result.failedTests, $result.reverted)
}
Write-Host ''
Write-Host "结果 JSON: $jsonPath"
