param(
    [string]$SourceHome = (Join-Path $env:USERPROFILE '.lingxi'),
    [string]$Destination = (Join-Path $PSScriptRoot '../.lingxi/development'),
    # SQLite 驱动 jar 与其所在本地仓库：默认从 Maven 本地仓库里按 pom 固定的版本找。
    [string]$SqliteJdbcJar = '',
    [string]$LocalRepository = ''
)

$ErrorActionPreference = 'Stop'
function Get-Sha256File([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

# Java 与 sqlite-jdbc：库快照必须走驱动（VACUUM INTO），不能复制正在写入的主文件。
function Resolve-JavaExecutable([string]$Name) {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME "bin/$Name.exe") }
    $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw "找不到 $Name.exe，请安装 JDK 21 并设置 JAVA_HOME 后重试。"
}

function Resolve-LocalRepository {
    if ($LocalRepository) { return [System.IO.Path]::GetFullPath($LocalRepository) }
    if ($env:MAVEN_REPO_LOCAL) { return [System.IO.Path]::GetFullPath($env:MAVEN_REPO_LOCAL) }
    $settingsPath = Join-Path $env:USERPROFILE '.m2/settings.xml'
    if (Test-Path -LiteralPath $settingsPath) {
        $match = Select-String -LiteralPath $settingsPath -Pattern '<localRepository>\s*([^<]+?)\s*</localRepository>' |
            Select-Object -First 1
        if ($match) { return [System.IO.Path]::GetFullPath($match.Matches[0].Groups[1].Value) }
    }
    return (Join-Path $env:USERPROFILE '.m2/repository')
}

function Resolve-SqliteJdbcJar([string]$Repository) {
    if ($SqliteJdbcJar) {
        $explicit = [System.IO.Path]::GetFullPath($SqliteJdbcJar)
        if (-not (Test-Path -LiteralPath $explicit)) { throw "指定的 sqlite-jdbc jar 不存在: $explicit" }
        return $explicit
    }
    $pomPath = Join-Path $PSScriptRoot '../pom.xml'
    $pinned = $null
    if (Test-Path -LiteralPath $pomPath) {
        $match = Select-String -LiteralPath $pomPath -Pattern '<sqlite-jdbc>\s*([^<]+?)\s*</sqlite-jdbc>' |
            Select-Object -First 1
        if ($match) { $pinned = $match.Matches[0].Groups[1].Value }
    }
    $versionRoot = Join-Path $Repository 'org/xerial/sqlite-jdbc'
    if (-not (Test-Path -LiteralPath $versionRoot)) {
        throw "本地 Maven 仓库里没有 sqlite-jdbc: $versionRoot（先执行一次 mvn -o test 拉取依赖，或用 -SqliteJdbcJar 指定）"
    }
    if ($pinned) {
        $jar = Join-Path $versionRoot "$pinned/sqlite-jdbc-$pinned.jar"
        if (Test-Path -LiteralPath $jar) { return $jar }
    }
    $jar = Get-ChildItem -LiteralPath $versionRoot -Recurse -Filter 'sqlite-jdbc-*.jar' -File |
        Where-Object { $_.Name -notlike '*-sources.jar' -and $_.Name -notlike '*-javadoc.jar' } |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $jar) { throw "本地 Maven 仓库里找不到 sqlite-jdbc 的 jar: $versionRoot" }
    return $jar.FullName
}

$javaExecutable = Resolve-JavaExecutable 'java'
$javacExecutable = Resolve-JavaExecutable 'javac'
$repository = Resolve-LocalRepository
$jdbcJar = Resolve-SqliteJdbcJar $repository
$snapshotSource = Join-Path $PSScriptRoot 'SqliteSnapshot.java'
if (-not (Test-Path -LiteralPath $snapshotSource)) { throw "缺少库快照入口: $snapshotSource" }

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

# 数据目录是一个集合：SQLite 库文件 + checkpoints 目录（库里只存正文的文件标识）。
$databasePath = Join-Path $sourceData 'lingxi.sqlite'
$checkpointDirectory = Join-Path $sourceData 'checkpoints'
$stage = $destinationRoot + '.initializing-' + [guid]::NewGuid().ToString('N')
try {
    # 独占打开一次只用来证明「安装版/IDE 后端都退出了」：库被别的进程握着时不允许初始化。
    # 之后由驱动做 VACUUM INTO，WAL 里未合并的提交会被一并读进快照。
    try {
        $probe = [System.IO.File]::Open($databasePath, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $probe.Dispose()
    } catch {
        throw '数据库无法独占读取，请先退出安装版和 IDE 后端，再执行初始化。'
    }

    $stagedData = Join-Path $stage 'data'
    $classesDir = Join-Path $stage 'snapshot-classes'
    New-Item -ItemType Directory -Path $stagedData -Force | Out-Null
    New-Item -ItemType Directory -Path $classesDir -Force | Out-Null
    & $javacExecutable -d $classesDir $snapshotSource
    if ($LASTEXITCODE -ne 0) { throw '编译库快照入口失败，未启用开发目录。' }
    $snapshotTarget = Join-Path $stagedData 'lingxi.sqlite'
    $snapshotOutput = & $javaExecutable -cp "$classesDir$([System.IO.Path]::PathSeparator)$jdbcJar" `
        SqliteSnapshot --source $databasePath --target $snapshotTarget
    if ($LASTEXITCODE -ne 0) { throw '库快照生成失败，未启用开发目录。' }
    $snapshotLine = ($snapshotOutput | Select-Object -Last 1)
    if ($snapshotLine -notmatch 'sha256=([0-9A-F]+)') { throw "库快照输出无法解析: $snapshotLine" }
    $sourceHash = $Matches[1]
    if ($sourceHash -ne (Get-Sha256File $snapshotTarget)) {
        throw '库快照校验失败，未启用开发目录。'
    }
    # 检查点正文、图片、技能等一切非库文件按原样复制；checkpoints 必须整棵过去，
    # 否则新库里的 snapshot_file 会指向不存在的正文。
    Get-ChildItem -LiteralPath $sourceData -Force | Where-Object { $_.Name -notlike 'lingxi.sqlite*' } |
        ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $stagedData -Recurse -Force }
    if (-not (Test-Path -LiteralPath (Join-Path $stagedData 'checkpoints')) -and (Test-Path -LiteralPath $checkpointDirectory)) {
        Copy-Item -LiteralPath $checkpointDirectory -Destination (Join-Path $stagedData 'checkpoints') -Recurse -Force
    }
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
    Remove-Item -LiteralPath $classesDir -Recurse -Force
    $manifest = [ordered]@{
        copiedAt = [DateTimeOffset]::Now.ToString('o')
        sourceDataDirectory = $sourceData
        databaseSnapshot = 'VACUUM INTO'
        databaseSha256 = $sourceHash
        checkpointFiles = @(Get-ChildItem -LiteralPath (Join-Path $stagedData 'checkpoints') -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName.Substring((Join-Path $stagedData 'checkpoints').Length + 1) })
        configFiles = @(Get-ChildItem -LiteralPath (Join-Path $stage 'config') -File | ForEach-Object {
            @{ name = $_.Name; sha256 = (Get-Sha256File $_.FullName) }
        })
    }
    [System.IO.File]::WriteAllText((Join-Path $stage 'initialization.json'),
        (ConvertTo-Json -InputObject $manifest -Depth 5), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $stage -Destination $destinationRoot
    Write-Output "开发数据初始化完成: directory=$destinationRoot, databaseSha256=$sourceHash"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
