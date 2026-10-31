param(
    [string]$SourceHome = (Join-Path $env:USERPROFILE '.lingxi'),
    [string]$Destination = (Join-Path $PSScriptRoot '../.lingxi/development'),
    # 存储引擎：sqlite（默认，行为不变）或 h2（用一次性迁移工具把 SQLite 副本搬成 H2 文件库）。
    [ValidateSet('sqlite', 'h2')][string]$Engine = 'sqlite',
    # SQLite 驱动 jar 与其所在本地仓库：默认从 Maven 本地仓库里按 pom 固定的版本找。
    [string]$SqliteJdbcJar = '',
    [string]$LocalRepository = '',
    # H2 引擎专用：H2 驱动 jar 与基线 DDL；不传则分别按本地仓库与仓库约定路径解析。
    [string]$H2Jar = '',
    [string]$H2Schema = '',
    [string]$H2DatabaseName = 'lingxi-h2'
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
    # settings.xml 可能在两处：用户级 ~/.m2，以及 Maven 安装目录的 conf（本机就把仓库配在那里）。
    $settingsCandidates = @((Join-Path $env:USERPROFILE '.m2/settings.xml'))
    foreach ($homeVariable in @($env:MAVEN_HOME, $env:M2_HOME)) {
        if ($homeVariable) { $settingsCandidates += (Join-Path $homeVariable 'conf/settings.xml') }
    }
    $mavenCommand = Get-Command 'mvn.cmd' -ErrorAction SilentlyContinue
    if (-not $mavenCommand) { $mavenCommand = Get-Command 'mvn' -ErrorAction SilentlyContinue }
    if ($mavenCommand) {
        $mavenRoot = Split-Path -Parent (Split-Path -Parent $mavenCommand.Source)
        $settingsCandidates += (Join-Path $mavenRoot 'conf/settings.xml')
    }
    foreach ($settingsPath in $settingsCandidates) {
        if (-not (Test-Path -LiteralPath $settingsPath)) { continue }
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
$engineName = $Engine.ToLowerInvariant()

# H2 分派的前置条件：H2 文件库不能热复制（见设计 §14.3 R3），所以只接受「SQLite 源 → 离线迁移」这一条路。
if ($engineName -eq 'h2') {
    $existingH2 = @(Get-ChildItem -LiteralPath $sourceData -Filter '*.mv.db' -File -ErrorAction SilentlyContinue)
    if ($existingH2.Count -gt 0) {
        throw ("源数据目录已经是 H2 文件库（{0}）：H2 库文件不能在运行中安全复制，" -f $existingH2[0].Name) +
            '请先退出安装版再用离线迁移，或直接由安装版自身完成 H2 迁移。'
    }
    if (-not (Test-Path -LiteralPath $databasePath)) {
        throw "H2 引擎初始化需要源目录里的 SQLite 库作为迁移来源，但找不到: $databasePath"
    }
}
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
    # H2 引擎下 SQLite 快照只是迁移的中间产物（放在 stage/snapshot，迁完即删），
    # 最终数据目录里应当只有 lingxi-h2.mv.db、checkpoints 与清单；SQLite 引擎保持不变。
    $snapshotTarget = if ($engineName -eq 'h2') {
        $snapshotDirectory = Join-Path $stage 'snapshot'
        New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null
        Join-Path $snapshotDirectory 'lingxi.sqlite'
    } else {
        Join-Path $stagedData 'lingxi.sqlite'
    }
    $snapshotOutput = & $javaExecutable -cp "$classesDir$([System.IO.Path]::PathSeparator)$jdbcJar" `
        SqliteSnapshot --source $databasePath --target $snapshotTarget
    if ($LASTEXITCODE -ne 0) { throw '库快照生成失败，未启用开发目录。' }
    $snapshotLine = ($snapshotOutput | Select-Object -Last 1)
    if ($snapshotLine -notmatch 'sha256=([0-9A-F]+)') { throw "库快照输出无法解析: $snapshotLine" }
    $sourceHash = $Matches[1]
    if ($sourceHash -ne (Get-Sha256File $snapshotTarget)) {
        throw '库快照校验失败，未启用开发目录。'
    }
    if ($engineName -eq 'h2') {
        # 一次性迁移：把 SQLite 快照搬进空的 stagedData，产出 H2 库 + 清单 + checkpoints。
        # 用独立 powershell 进程调用，避免迁移脚本里的 exit 把本脚本的 finally 一起带走。
        #
        # 注意：本脚本**任何路径都不会传 -DeriveSchema**（开发目录必须能真的启动应用）。
        # 迁移脚本与工具两侧都要求 -DeriveSchema 必须配 -AllowDerivedSchemaForDrill，且演练产物
        # 清单恒为 verified=false、并带 DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt；下面的双重校验把
        # 「演练产物误入开发目录」这条路彻底堵死。
        $migrationScript = Join-Path $PSScriptRoot 'Migrate-SqliteToH2.ps1'
        if (-not (Test-Path -LiteralPath $migrationScript)) { throw "缺少迁移启动脚本: $migrationScript" }
        $migrationCommand = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $migrationScript,
            '-Source', $snapshotTarget,
            '-Target', $stagedData,
            '-DatabaseName', $H2DatabaseName
        )
        if (Test-Path -LiteralPath $checkpointDirectory) {
            $migrationCommand += @('-Checkpoints', $checkpointDirectory)
        }
        if ($H2Jar) { $migrationCommand += @('-H2Jar', $H2Jar) }
        if ($H2Schema) { $migrationCommand += @('-Schema', $H2Schema) }
        if ($LocalRepository) { $migrationCommand += @('-LocalRepository', $LocalRepository) }
        if ($SqliteJdbcJar) { $migrationCommand += @('-SqliteJdbcJar', $SqliteJdbcJar) }
        & powershell @migrationCommand
        if ($LASTEXITCODE -ne 0) {
            throw "SQLite → H2 迁移失败（退出码 $LASTEXITCODE），未启用开发目录。"
        }
        $derivedMarker = Join-Path $stagedData 'DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt'
        if (Test-Path -LiteralPath $derivedMarker) {
            throw ('迁移产物带 DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt：这是推导结构的演练库，' +
                '不得用于开发目录。请用真实 H2 基线 DDL（-H2Schema 或 src/main/resources/db/h2/V1__schema.sql）重做。')
        }
        $migrationManifestPath = Join-Path $stagedData 'migration-from-sqlite.json'
        if (-not (Test-Path -LiteralPath $migrationManifestPath)) {
            throw '迁移清单缺失，未启用开发目录。'
        }
        $h2Manifest = Get-Content -LiteralPath $migrationManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($h2Manifest.verified -ne $true) {
            throw "迁移清单 verified 不为 true（$($h2Manifest.failureReason)），未启用开发目录。"
        }
        # 迁移用的 SQLite 快照只服务这一次搬运，不留在开发数据目录里。
        Remove-Item -LiteralPath (Join-Path $stage 'snapshot') -Recurse -Force
    }
    # 检查点正文、图片、技能等一切非库文件按原样复制；checkpoints 必须整棵过去，
    # 否则新库里的 snapshot_file 会指向不存在的正文。
    # H2 引擎只在过滤上多排除 H2 自身的库/追踪文件；SQLite 引擎的匹配行为保持原样。
    $copyFilter = if ($engineName -eq 'h2') {
        { $_.Name -notlike 'lingxi.sqlite*' -and $_.Name -notlike '*.mv.db' -and $_.Name -notlike '*.trace.db' -and $_.Name -notlike '*.lock.db' }
    } else {
        { $_.Name -notlike 'lingxi.sqlite*' }
    }
    Get-ChildItem -LiteralPath $sourceData -Force | Where-Object $copyFilter |
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
        engine = $engineName
        databaseSnapshot = 'VACUUM INTO'
        databaseSha256 = $sourceHash
        checkpointFiles = @(Get-ChildItem -LiteralPath (Join-Path $stagedData 'checkpoints') -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object { $_.FullName.Substring((Join-Path $stagedData 'checkpoints').Length + 1) })
        configFiles = @(Get-ChildItem -LiteralPath (Join-Path $stage 'config') -File | ForEach-Object {
            @{ name = $_.Name; sha256 = (Get-Sha256File $_.FullName) }
        })
    }
    if ($engineName -eq 'h2') {
        # 开发目录用 H2 时，把迁移清单里的关键凭据也记进 initialization.json：
        # 出问题时先看这里，就能知道这份开发库是哪一次迁移、验没验过。
        $manifest.engine = 'h2'
        $manifest.h2DatabaseFile = $h2Manifest.targetDatabaseFile
        $manifest.h2MigrationVerified = $h2Manifest.verified
        $manifest.h2MigrationToolVersion = $h2Manifest.toolVersion
        $manifest.h2MigrationSourceSha256 = $h2Manifest.sourceSha256
        $manifest.h2MigrationTables = @($h2Manifest.tableFingerprints.PSObject.Properties).Count
    }
    [System.IO.File]::WriteAllText((Join-Path $stage 'initialization.json'),
        (ConvertTo-Json -InputObject $manifest -Depth 5), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $stage -Destination $destinationRoot
    Write-Output "开发数据初始化完成: directory=$destinationRoot, databaseSha256=$sourceHash"
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
