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

# 子进程输出会被 Java 侧按 UTF-8 解码（DevelopmentInitializationTest 用 new String(bytes, UTF_8) 读日志），
# 而 Windows PowerShell 5.1 默认按控制台/OEM 代码页输出；中文报错到 CI 上就只剩 "??????"，
# 等于没有诊断信息。这里显式把控制台输出编码（stdout 与 stderr 同源）改成无 BOM 的 UTF-8。
# 设不上也不致命（例如没有控制台句柄时），所以 try/catch 兜住，不能因为编码设置失败把迁移弄挂。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    # 忽略：输出编码设置失败只影响可读性，不影响迁移正确性
}

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
# 解析时把"看过哪些位置、结论是什么"记下来：迁移失败时必须能一眼看出它到底找过哪里
# （CI 上就是这种情况——本地仓库不在 ~/.m2，而在构建的隔离仓库里）。
$script:RepositorySearchLog = New-Object 'System.Collections.Generic.List[string]'

function Add-RepositorySearchNote([string]$Note) {
    $script:RepositorySearchLog.Add($Note) | Out-Null
}

# 读 settings.xml 前先剥掉 XML 注释。
# 为什么必须剥：Maven 发行版自带的 conf/settings.xml 里就有被注释掉的示例
# `<localRepository>/path/to/local/repo</localRepository>`；不剥注释会把它当成真实配置
# （实测：CI 条件下一路解析成 `D:\path\to\local\repo`，把"缺 jar"的结论指向一个不存在的位置）。
function Read-SettingsWithoutComments([string]$Path) {
    $raw = [System.IO.File]::ReadAllText($Path)
    return [System.Text.RegularExpressions.Regex]::Replace($raw, '(?s)<!--.*?-->', '')
}

function Resolve-LocalRepository {
    if ($LocalRepository) {
        $full = [System.IO.Path]::GetFullPath($LocalRepository)
        Add-RepositorySearchNote "参数 -LocalRepository 指定 → $full"
        return $full
    }
    if ($env:MAVEN_REPO_LOCAL) {
        $full = [System.IO.Path]::GetFullPath($env:MAVEN_REPO_LOCAL)
        Add-RepositorySearchNote "环境变量 MAVEN_REPO_LOCAL → $full"
        return $full
    }
    Add-RepositorySearchNote '未传 -LocalRepository 且没有 MAVEN_REPO_LOCAL → 退到 settings.xml / ~/.m2（构建期隔离仓库在这条路径上看不见）'
    $settingsCandidates = @((Join-Path $env:USERPROFILE '.m2/settings.xml'))
    foreach ($homeVariable in @($env:MAVEN_HOME, $env:M2_HOME)) {
        if ($homeVariable) { $settingsCandidates += (Join-Path $homeVariable 'conf/settings.xml') }
    }
    $mavenCommand = Get-Command 'mvn.cmd' -ErrorAction SilentlyContinue
    if (-not $mavenCommand) { $mavenCommand = Get-Command 'mvn' -ErrorAction SilentlyContinue }
    if ($mavenCommand) {
        $mavenRoot = Split-Path -Parent (Split-Path -Parent $mavenCommand.Source)
        $settingsCandidates += (Join-Path $mavenRoot 'conf/settings.xml')
    } else {
        Add-RepositorySearchNote 'PATH 里没有 mvn.cmd / mvn → 少一处 settings.xml 候选（CI 用的就是仓库 wrapper）'
    }
    foreach ($settingsPath in $settingsCandidates) {
        if (-not (Test-Path -LiteralPath $settingsPath)) {
            Add-RepositorySearchNote "settings 候选不存在: $settingsPath"
            continue
        }
        $settingsText = Read-SettingsWithoutComments $settingsPath
        $match = [System.Text.RegularExpressions.Regex]::Match($settingsText, '<localRepository>\s*([^<]+?)\s*</localRepository>')
        if ($match.Success) {
            $configured = [System.IO.Path]::GetFullPath($match.Groups[1].Value)
            Add-RepositorySearchNote "$settingsPath 的 <localRepository>（已剥注释）→ $configured"
            return $configured
        }
        Add-RepositorySearchNote "$settingsPath 存在但没有生效的 <localRepository>（注释里的示例不算）"
    }
    $fallback = Join-Path $env:USERPROFILE '.m2/repository'
    Add-RepositorySearchNote "兜底（默认本地仓库）→ $fallback"
    return $fallback
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

# 依赖解析失败的**可诊断**报告：期望目录/期望文件 + 实际搜索过的位置 + 三条显式修法。
# 为什么必须这么啰嗦：CI 上这条失败以前只输出 "expected: <0> but was: <1>"（迁移子进程的非 0
# 退出码被折叠成一句断言），既看不出缺哪个 jar，也看不出脚本找过哪些仓库 —— 排查成本极高。
function Format-JarResolutionFailure([string]$FlagName, [string]$GroupPath, [string]$ArtifactId, [string]$PomTag, [string]$ExpectedDir) {
    $pinned = Read-PomVersion $PomTag
    $expectedJar = if ($pinned) {
        Join-Path $ExpectedDir "$pinned/$ArtifactId-$pinned.jar"
    } else {
        Join-Path $ExpectedDir "$ArtifactId-<version>.jar"
    }
    $searchLines = if ($script:RepositorySearchLog.Count -gt 0) {
        ($script:RepositorySearchLog | ForEach-Object { "      - $_" }) -join [Environment]::NewLine
    } else {
        '      - （没有记录：解析在写日志前就结束了）'
    }
    $explicitFlag = switch ($GroupPath) {
        'com/h2database/h2' { '-H2Jar' }
        'org/xerial/sqlite-jdbc' { '-SqliteJdbcJar' }
        default { $FlagName }
    }
    $lines = @(
        "找不到依赖 $ArtifactId 的 jar：本地仓库里没有 $GroupPath 目录。",
        "  期望目录: $ExpectedDir",
        "  期望文件: $expectedJar",
        '  本地仓库解析过程（脚本实际搜索/采用过的位置，从上到下就是优先级）:',
        $searchLines,
        "  如何显式指定（三选一，都优先于环境变量与自动解析）:",
        "    1) -LocalRepository <本地仓库根目录>        （例如构建用的隔离仓库 .run/maven/<hash>）",
        "    2) 环境变量 MAVEN_REPO_LOCAL=<本地仓库根目录>",
        "    3) $explicitFlag <jar 的绝对路径>",
        "  说明: CI 上依赖只落在构建的隔离仓库里（.run/maven/<hash>），~/.m2/repository 是空的；",
        "        frontend/scripts/maven-runtime.mjs 会把该隔离仓库以 MAVEN_REPO_LOCAL 传给本脚本。",
        "  本地复跑: 先 mvn -o test 拉一次依赖，或用上面的方式显式指定。"
    )
    return ($lines -join [Environment]::NewLine)
}

function Resolve-DependencyJar([string]$FlagName, [string]$Explicit, [string]$GroupPath, [string]$ArtifactId, [string]$PomTag) {
    if ($Explicit) {
        $full = [System.IO.Path]::GetFullPath($Explicit)
        if (-not (Test-Path -LiteralPath $full)) { Write-Fail "$FlagName 指定的 jar 不存在: $full" $script:ExitInvalidArgument }
        return $full
    }
    $versionRoot = Join-Path $script:RepositoryResolved $GroupPath
    if (-not (Test-Path -LiteralPath $versionRoot)) {
        Write-Fail (Format-JarResolutionFailure $FlagName $GroupPath $ArtifactId $PomTag $versionRoot) $script:ExitInvalidArgument
    }
    $pinned = Read-PomVersion $PomTag
    $candidates = @()
    if ($pinned) { $candidates += (Join-Path $versionRoot "$pinned/$ArtifactId-$pinned.jar") }
    $resolved = Resolve-FirstExistingJar $candidates
    if ($resolved) { return $resolved }
    $jar = Get-ChildItem -LiteralPath $versionRoot -Recurse -Filter "$ArtifactId-*.jar" -File |
        Where-Object { $_.Name -notlike '*-sources.jar' -and $_.Name -notlike '*-javadoc.jar' } |
        Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $jar) {
        Write-Fail (Format-JarResolutionFailure $FlagName $GroupPath $ArtifactId $PomTag $versionRoot) $script:ExitInvalidArgument
    }
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
    # 迁移工具的告警/失败原因同样是人要读的诊断信息：显式让它按 UTF-8 输出。
    # 否则 Windows 上它按 OEM 代码页写中文，Java 侧（按 UTF-8 读日志）看到的就是 ??????。
    # 这两个属性只影响控制台输出编码，不改变业务语义（JDK 19+ 支持）。
    $toolArguments = @('-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
        '-cp', $classpath, 'SqliteToH2Migration',
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
