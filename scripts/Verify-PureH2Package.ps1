param([Parameter(Mandatory = $true)][string]$Jar)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Find-SqliteEntries([string[]]$Names) {
    @($Names | Where-Object { $_ -match '(?i)(sqlite|StorageEngine\.class|StorageEngineProperties\.class|StorageEngineEnvironmentPostProcessor\.class|TimeTextCodec\.class|ChecklistWriteMonitor(?:\$[^/]*)?\.class)' })
}

# 正样本包含嵌套路径，验证实际扫描谓词确实识别运行依赖和旧适配。
$canaries = @('BOOT-INF/lib/sqlite-jdbc-1.jar', 'BOOT-INF/classes/db/sqlite/V1__schema.sql',
    'BOOT-INF/classes/com/summit/dp/shared/storage/StorageEngine.class',
    'BOOT-INF/classes/com/summit/dp/checklist/infrastructure/persistence/ChecklistWriteMonitor.class')
if (@(Find-SqliteEntries $canaries).Count -ne $canaries.Count) { throw '打包扫描器正对照失败。' }
$archive = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($Jar))
try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName })
    $violations = @(Find-SqliteEntries $names)
    if ($violations.Count -gt 0) { throw ('运行包含 SQLite 或旧引擎适配: ' + ($violations -join ', ')) }
    if (@($names | Where-Object { $_ -match '^BOOT-INF/lib/h2-[^/]+\.jar$' }).Count -ne 1) {
        throw '运行包必须恰好包含一个 H2 驱动。'
    }
    foreach ($required in @('BOOT-INF/classes/db/h2/V1__schema.sql', 'BOOT-INF/classes/application.yaml')) {
        if ($names -notcontains $required) { throw "运行包缺少必要资源: $required" }
    }
    Write-Output "纯 H2 打包校验通过: entries=$($names.Count), jar=$Jar"
} finally { $archive.Dispose() }
