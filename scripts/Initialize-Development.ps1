param(
    [string]$SourceHome = (Join-Path $env:USERPROFILE '.lingxi'),
    [string]$Destination = (Join-Path $PSScriptRoot '../.lingxi/development')
)

$ErrorActionPreference = 'Stop'
function Get-Sha256File([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$sourceRoot = [System.IO.Path]::GetFullPath($SourceHome)
$destinationRoot = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destinationRoot) {
    throw '开发目录已存在，初始化不会覆盖已有开发数据。'
}

$sourceConfig = Join-Path $sourceRoot 'config'
$settingsPath = Join-Path $sourceConfig 'user-configs.json'
$settings = if (Test-Path -LiteralPath $settingsPath) {
    @(Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json)
} else { @() }
$configuredData = $settings | Where-Object { -not [string]::IsNullOrWhiteSpace($_.dataDir) } | Select-Object -First 1
$configuredSkill = $settings | Where-Object { -not [string]::IsNullOrWhiteSpace($_.skillDir) } | Select-Object -First 1
$sourceData = if ($configuredData) { $configuredData.dataDir } else { Join-Path $sourceRoot 'data' }
$sourceSkill = if ($configuredSkill) { $configuredSkill.skillDir } else { Join-Path $sourceRoot 'skill' }
$sourceData = [System.IO.Path]::GetFullPath($sourceData)
if ($destinationRoot.StartsWith($sourceRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $destinationRoot -eq $sourceRoot -or
    $destinationRoot.StartsWith($sourceData + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or
    $destinationRoot -eq $sourceData) {
    throw '开发目录必须位于安装版数据和配置目录之外。'
}

$databasePath = Join-Path $sourceData 'lingxi.mv.db'
$database = $null
$stage = $destinationRoot + '.initializing-' + [guid]::NewGuid().ToString('N')
try {
    # 持有独占句柄直到副本校验完成，禁止复制期间任何进程重开数据库。
    try {
        $database = [System.IO.File]::Open($databasePath, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    } catch {
        throw '数据库无法独占读取，请先退出安装版和 IDE 后端，再执行初始化。'
    }
    New-Item -ItemType Directory -Path (Join-Path $stage 'data') -Force | Out-Null
    $copiedDatabase = Join-Path $stage 'data/lingxi.mv.db'
    $output = [System.IO.File]::Create($copiedDatabase)
    try { $database.CopyTo($output) } finally { $output.Dispose() }
    $database.Position = 0
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $sourceHash = [BitConverter]::ToString($sha.ComputeHash($database)).Replace('-', '') }
    finally { $sha.Dispose() }
    if ($sourceHash -ne (Get-Sha256File $copiedDatabase)) {
        throw '数据库副本校验失败，未启用开发目录。'
    }
    Get-ChildItem -LiteralPath $sourceData -Force | Where-Object { $_.Name -notlike 'lingxi.*.db' } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage 'data') -Recurse -Force }
    Copy-Item -LiteralPath $sourceConfig -Destination (Join-Path $stage 'config') -Recurse
    if (Test-Path -LiteralPath $sourceSkill) {
        Copy-Item -LiteralPath $sourceSkill -Destination (Join-Path $stage 'skill') -Recurse
    }
    # 副本保留业务设置，仅将可写目录改到开发根目录，避免启动期设置覆盖隔离路径。
    foreach ($row in $settings) {
        $row | Add-Member -NotePropertyName dataDir -NotePropertyValue (Join-Path $destinationRoot 'data') -Force
        $row | Add-Member -NotePropertyName skillDir -NotePropertyValue (Join-Path $destinationRoot 'skill') -Force
    }
    if (Test-Path -LiteralPath $settingsPath) {
        $json = ConvertTo-Json -InputObject @($settings) -Depth 50
        [System.IO.File]::WriteAllText((Join-Path $stage 'config/user-configs.json'), $json,
            [System.Text.UTF8Encoding]::new($false))
    }
    $manifest = [ordered]@{
        copiedAt = [DateTimeOffset]::Now.ToString('o')
        sourceDataDirectory = $sourceData
        databaseSha256 = $sourceHash
        configFiles = @(Get-ChildItem -LiteralPath (Join-Path $stage 'config') -File | ForEach-Object {
            @{ name = $_.Name; sha256 = (Get-Sha256File $_.FullName) }
        })
    }
    [System.IO.File]::WriteAllText((Join-Path $stage 'initialization.json'),
        (ConvertTo-Json -InputObject $manifest -Depth 5), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $stage -Destination $destinationRoot
    Write-Output "开发数据初始化完成: directory=$destinationRoot, databaseSha256=$sourceHash"
} finally {
    if ($null -ne $database) { $database.Dispose() }
}
