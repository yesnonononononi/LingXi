param(
    # 必填：SQLite 库**副本**（绝不自动挑选源目录，也不允许指向真实数据目录）。
    [Parameter(Mandatory = $true)][string]$Source,
    # 必填：目标目录。迁移时必须不存在或为空；--Verify 时必须已有 H2 库与清单。
    [Parameter(Mandatory = $true)][string]$Target,
    # 检查点正文目录；缺省用 <Source 父目录>/checkpoints（安装版数据目录的既有布局）。
    [string]$Checkpoints = '',
    # 迁移清单路径；缺省用 <Target>/migration-from-sqlite.json。
    [string]$Manifest = '',
    # 批大小（不含 CLOB 的行走批处理）。
    [int]$Batch = 500,
    # 只复算比对，不写业务数据。
    [switch]$Verify,
    # H2 基线 DDL；缺省按仓库约定路径查找（src/main/resources/db/h2/V1__schema.sql）。
    [string]$Schema = '',
    # 演练：按源库结构推导 DDL。**必须**同时给出 -AllowDerivedSchemaForDrill，否则直接按参数错误退出。
    [switch]$DeriveSchema,
    # 演练硬开关：显式承认「产物不用于生产」。产物清单恒为 verified=false，并写 DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt。
    [switch]$AllowDerivedSchemaForDrill,
    # H2 库文件名主干。
    [string]$DatabaseName = 'lingxi-h2',
    # 显式指定 jar，跳过本地仓库解析。
    [string]$H2Jar = '',
    [string]$SqliteJdbcJar = '',
    [string]$LocalRepository = '',
    # 仓库根目录：用于数据目录禁区判定与基线脚本定位。
    [string]$RepoRoot = ''
)

$ErrorActionPreference = 'Stop'

# 一次性迁移工具启动器：解析 jar、强制显式 --source/--target、规范化路径、禁区拒绝，再调用工具。
# 为什么校验要在这里也做一遍：脚本是人的入口，宁可脚本先拒（退出码 3、一个文件都不建），
# 也不要让工具跑了半路才发现路径写错；工具侧仍保留同一套判定，作为最后一道闸。

$script:ExitForbiddenPath = 3
$script:ExitInvalidArgument = 2

function Write-Fail([string]$Message, [int]$ExitCode) {
    [Console]::Error.WriteLine($Message)
    exit $ExitCode
}

# Java 与 javac：优先 JAVA_HOME，其次 PATH。
function Resolve-JavaExecutable([string]$Name) {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += (Join-Path $env:JAVA_HOME "bin/$Name.exe") }
    $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
    if ($command) { $candidates += $command.Source }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    Write-Fail "找不到 $Name.exe，请安装 JDK 21 并设置 JAVA_HOME 后重试。" $script:ExitInvalidArgument
}

# 本地仓库解析顺序与 Initialize-Development.ps1 保持一致，避免两套脚本各说各话。
function Resolve-LocalRepository {
    if ($LocalRepository) { return [System.IO.Path]::GetFullPath($LocalRepository) }
    if ($env:MAVEN_REPO_LOCAL) { return [System.IO.Path]::GetFullPath($env:MAVEN_REPO_LOCAL) }
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

# pom.xml 里固定的版本；读不到就返回空串（由调用方退化为「取本地仓库里最新的 jar」）。
function Read-PomVersion([string]$Tag) {
    $pomPath = Join-Path $script:RepoRootResolved 'pom.xml'
    if (-not (Test-Path -LiteralPath $pomPath)) { return '' }
    $match = Select-String -LiteralPath $pomPath -Pattern "<$Tag>\s*([^<]+?)\s*</$Tag>" | Select-Object -First 1
    if ($match) { return $match.Matches[0].Groups[1].Value }
    return ''
}

function Resolve-FirstExistingJar([string[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    return ''
}

function Resolve-DependencyJar([string]$FlagName, [string]$Explicit, [string]$GroupPath, [string]$ArtifactId, [string]$PomTag) {
    if ($Explicit) {
        $full = [System.IO.Path]::GetFullPath($Explicit)
        if (-not (Test-Path -LiteralPath $full)) { Write-Fail "$FlagName 指定的 jar 不存在: $full" $script:ExitInvalidArgument }
        return $full
    }
    $versionRoot = Join-Path $script:RepositoryResolved $GroupPath
    if (-not (Test-Path -LiteralPath $versionRoot)) {
        Write-Fail "本地 Maven 仓库里没有 ${ArtifactId}: $versionRoot（先执行一次 mvn -o test 拉取依赖，或用 $FlagName 指定）" $script:ExitInvalidArgument
    }
    $pinned = Read-PomVersion $PomTag
    $candidates = @()
    if ($pinned) { $candidates += (Join-Path $versionRoot "$pinned/$ArtifactId-$pinned.jar") }
    $resolved = Resolve-FirstExistingJar $candidates
    if ($resolved) { return $resolved }
    $jar = Get-ChildItem -LiteralPath $versionRoot -Recurse -Filter "$ArtifactId-*.jar" -File |
        Where-Object { $_.Name -notlike '*-sources.jar' -and $_.Name -notlike '*-javadoc.jar' } |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $jar) { Write-Fail "本地 Maven 仓库里找不到 $ArtifactId 的 jar: $versionRoot" $script:ExitInvalidArgument }
    return $jar.FullName
}

# 禁区判定：规范化绝对路径后，「落在禁区里」或「是禁区的父目录」都拒绝。
function Assert-PathAllowed([string]$FlagName, [string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    $full = [System.IO.Path]::GetFullPath($Path)
    foreach ($banned in $script:ForbiddenPaths) {
        $separator = [System.IO.Path]::DirectorySeparatorChar
        $insideBanned = $full.StartsWith($banned + $separator, [StringComparison]::OrdinalIgnoreCase) -or
            $full.Equals($banned, [StringComparison]::OrdinalIgnoreCase)
        $ancestorOfBanned = $banned.StartsWith($full + $separator, [StringComparison]::OrdinalIgnoreCase)
        if ($insideBanned -or $ancestorOfBanned) {
            Write-Fail ("拒绝执行（路径禁区）: $FlagName=$full 命中禁区 $banned（该目录及其父/子目录一律拒绝）") $script:ExitForbiddenPath
        }
    }
}

# 仓库根：显式优先，其次脚本上级目录；必须能找到 pom.xml，否则禁区判定缺少一条规则。
$script:RepoRootResolved = if ($RepoRoot) {
    [System.IO.Path]::GetFullPath($RepoRoot)
} else {
    [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../'))
}
if (-not (Test-Path -LiteralPath (Join-Path $script:RepoRootResolved 'pom.xml'))) {
    Write-Fail "仓库根目录没有 pom.xml: $($script:RepoRootResolved)（用 -RepoRoot 指定）" $script:ExitInvalidArgument
}

$script:ForbiddenPaths = @(
    [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.lingxi/data')),
    [System.IO.Path]::GetFullPath((Join-Path $script:RepoRootResolved '.lingxi/development/data'))
)

Assert-PathAllowed '-Source' $Source
Assert-PathAllowed '-Target' $Target
Assert-PathAllowed '-Checkpoints' $Checkpoints
Assert-PathAllowed '-Manifest' $Manifest
Assert-PathAllowed '-Schema' $Schema

$sourceFull = [System.IO.Path]::GetFullPath($Source)
$targetFull = [System.IO.Path]::GetFullPath($Target)
if (-not (Test-Path -LiteralPath $sourceFull -PathType Leaf)) {
    Write-Fail "源库副本不存在（必须指向复制出来的副本，而不是正在使用的库）: $sourceFull" $script:ExitInvalidArgument
}
if ($Batch -le 0) {
    Write-Fail "-Batch 必须大于 0: $Batch" $script:ExitInvalidArgument
}
if (-not $Verify) {
    if (Test-Path -LiteralPath $targetFull) {
        if (-not (Test-Path -LiteralPath $targetFull -PathType Container)) {
            Write-Fail "目标必须是目录: $targetFull" $script:ExitForbiddenPath
        }
        $existing = @(Get-ChildItem -LiteralPath $targetFull -Force -ErrorAction SilentlyContinue)
        if ($existing.Count -gt 0) {
            Write-Fail "目标目录已存在且非空，拒绝覆盖: $targetFull（换一个空目录重跑）" $script:ExitForbiddenPath
        }
    }
}

# 演练开关配对校验（与工具侧同一规则，脚本先拒一次）：
# 推导结构会把 SQLite 的 TEXT 推成 VARCHAR(1000000000) 而不是 CLOB，等于复刻历史 OOM 事故，
# 所以「单独 -DeriveSchema」必须当参数错误，而不是「顺手给个默认行为」。
if ($DeriveSchema -and -not $AllowDerivedSchemaForDrill) {
    Write-Fail ("参数错误: -DeriveSchema 必须与 -AllowDerivedSchemaForDrill 同时使用。" +
        "按源库结构推导 H2 DDL 会把 SQLite 的 TEXT 列推导成 VARCHAR(1000000000) 而不是 CLOB（H2 2.5.252 实测），" +
        "大文本整段驻留等于复刻历史 OOM 事故；因此推导只能用于演练，产物清单恒为 verified=false 且带 " +
        "DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt 标记，不得用于应用启动。") $script:ExitInvalidArgument
}
if ($AllowDerivedSchemaForDrill -and -not $DeriveSchema) {
    Write-Fail "参数错误: -AllowDerivedSchemaForDrill 必须与 -DeriveSchema 同时使用（它只是演练确认开关，本身不产生任何行为）。" $script:ExitInvalidArgument
}
if ($DeriveSchema -and $Schema) {
    Write-Fail "参数错误: -Schema 与 -DeriveSchema 互斥（前者用真实基线，后者是推导演练）。" $script:ExitInvalidArgument
}

$script:RepositoryResolved = Resolve-LocalRepository
$h2JarPath = if ($H2Jar) {
    Resolve-DependencyJar '-H2Jar' $H2Jar 'com/h2database/h2' 'h2' 'h2'
} elseif ($env:LINGXI_H2_JAR) {
    Resolve-DependencyJar '-H2Jar' $env:LINGXI_H2_JAR 'com/h2database/h2' 'h2' 'h2'
} else {
    Resolve-DependencyJar '-H2Jar' '' 'com/h2database/h2' 'h2' 'h2'
}
$sqliteJarPath = Resolve-DependencyJar '-SqliteJdbcJar' $SqliteJdbcJar 'org/xerial/sqlite-jdbc' 'sqlite-jdbc' 'sqlite-jdbc'

$javaExecutable = Resolve-JavaExecutable 'java'
$javacExecutable = Resolve-JavaExecutable 'javac'
$toolSource = Join-Path $script:RepoRootResolved 'tools/migrate/SqliteToH2Migration.java'
if (-not (Test-Path -LiteralPath $toolSource)) {
    Write-Fail "缺少迁移工具源码: $toolSource" $script:ExitInvalidArgument
}

$manifestFull = if ($Manifest) { [System.IO.Path]::GetFullPath($Manifest) } else { '' }
$checkpointsFull = if ($Checkpoints) { [System.IO.Path]::GetFullPath($Checkpoints) } else { '' }
$schemaFull = if ($Schema) { [System.IO.Path]::GetFullPath($Schema) } else { '' }
if ($schemaFull -and -not (Test-Path -LiteralPath $schemaFull -PathType Leaf)) {
    Write-Fail "指定的 H2 基线脚本不存在: $schemaFull" $script:ExitInvalidArgument
}

$verifyRoot = Join-Path $env:TEMP 'lingxi-h2-verify'
New-Item -ItemType Directory -Path $verifyRoot -Force | Out-Null
$classesDir = Join-Path $verifyRoot ('tool-classes-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$toolExitCode = 1
try {
    New-Item -ItemType Directory -Path $classesDir -Force | Out-Null
    & $javacExecutable -encoding UTF-8 -cp "$h2JarPath$([System.IO.Path]::PathSeparator)$sqliteJarPath" `
        -d $classesDir $toolSource
    if ($LASTEXITCODE -ne 0) { Write-Fail '编译迁移工具失败' $script:ExitInvalidArgument }

    $classpath = "$classesDir$([System.IO.Path]::PathSeparator)$h2JarPath$([System.IO.Path]::PathSeparator)$sqliteJarPath"
    $toolArguments = @('-cp', $classpath, 'SqliteToH2Migration',
        '--source', $sourceFull,
        '--target', $targetFull,
        '--repo-root', $script:RepoRootResolved,
        '--batch', $Batch,
        '--database-name', $DatabaseName)
    if ($manifestFull) { $toolArguments += @('--manifest', $manifestFull) }
    if ($checkpointsFull) { $toolArguments += @('--checkpoints', $checkpointsFull) }
    if ($schemaFull) { $toolArguments += @('--schema', $schemaFull) }
    if ($DeriveSchema) { $toolArguments += @('--derive-schema', '--allow-derived-schema-for-drill') }
    if ($Verify) { $toolArguments += '--verify' }

    $modeText = if ($Verify) { 'verify' } else { 'migrate' }
    Write-Output ("migrate-tool: java=$javaExecutable h2=$h2JarPath sqlite=$sqliteJarPath mode=$modeText")
    Write-Output "migrate-tool: source=$sourceFull target=$targetFull"
    if ($DeriveSchema) {
        Write-Output ("WARNING: 演练模式（-DeriveSchema + -AllowDerivedSchemaForDrill）：" +
            '产物清单恒为 verified=false，目标目录会写 DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt，该库不得被应用启动使用。')
    }
    & $javaExecutable @toolArguments
    $toolExitCode = $LASTEXITCODE
} finally {
    if (Test-Path -LiteralPath $classesDir) {
        Remove-Item -LiteralPath $classesDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

exit $toolExitCode
