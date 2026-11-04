<#
.SYNOPSIS
Maven 本地仓库解析的**唯一真源**：settings.xml 剥注释 + 提取 <localRepository> + 候选顺序 + 兜底。

.DESCRIPTION
为什么必须只有一份：同一条缺陷曾经在三个地方各写了一遍（scripts/Migrate-SqliteToH2.ps1、
scripts/Initialize-Development.ps1、frontend/tests/developmentIsolation.test.cjs），
于是"注释里的示例被当成真实配置"这个 bug 修一处、漏两处。

那个 bug 的具体形态（CI 上实测）：
  Maven 发行版自带的 conf/settings.xml 里有被注释掉的示例
  <localRepository>/path/to/local/repo</localRepository>；
  旧实现用注释盲的正则去匹配，于是把 /path/to/local/repo 当成真实配置，
  [System.IO.Path]::GetFullPath() 在当前盘符下把它解析成 D:\path\to\local\repo，
  最终报"本地仓库缺 h2"却指向一个根本不存在的位置 —— 报错有字，但指向错地方。

本文件是纯函数集合（无副作用、不 exit、不写日志文件），供：
  - scripts/Migrate-SqliteToH2.ps1
  - scripts/Initialize-Development.ps1
dot-source 使用；frontend/tests/developmentIsolation.test.cjs 通过 powershell -Command 调用，
因此 JS 侧不再维护第二套候选顺序。

候选顺序（从高到低，前面赢）：
  1. 调用方显式给的 -Explicit（-LocalRepository 参数）
  2. 环境变量 MAVEN_REPO_LOCAL
  3. 各 settings.xml 的 <localRepository>（$USERPROFILE/.m2、MAVEN_HOME、M2_HOME、PATH 上 mvn 的 conf）
  4. 兜底 $USERPROFILE/.m2/repository

两块判定规则以**常量**形式导出（Get-MavenSettingsPattern），是为了让 JS 侧能直接读取同一份
正则字符串，而不是各抄一份：规则只有一处真源。
#>

# 注释剥离规则：必须整段剥掉 <!-- ... -->，不能只按行剥（示例块跨多行）。
$script:MavenSettingsCommentPattern = '(?s)<!--.*?-->'
# <localRepository> 提取规则：值里不允许出现 '<'，两侧空白容忍。
$script:MavenSettingsLocalRepositoryPattern = '<localRepository>\s*([^<]+?)\s*</localRepository>'

<#
.SYNOPSIS
取一条判定规则的正则字符串（供调用方与测试读取同一份真值）。

.PARAMETER Name
comment = 注释剥离规则；localRepository = <localRepository> 提取规则。

.OUTPUTS
System.String
#>
function Get-MavenSettingsPattern {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('comment', 'localRepository')]
        [string]$Name
    )
    if ($Name -eq 'comment') { return $script:MavenSettingsCommentPattern }
    return $script:MavenSettingsLocalRepositoryPattern
}

<#
.SYNOPSIS
剥掉 XML 注释（跨行）。

.PARAMETER Text
settings.xml 全文。

.OUTPUTS
System.String 不含注释的文本；入参为空时返回空串。
#>
function Remove-MavenSettingsComments {
    param([string]$Text = '')
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    return [System.Text.RegularExpressions.Regex]::Replace($Text, $script:MavenSettingsCommentPattern, '')
}

<#
.SYNOPSIS
读一个 settings.xml 里**生效的** <localRepository>。

.DESCRIPTION
只有剥掉注释后仍然存在的元素才算配置。注释里的示例一律不算 —— 这正是本文件存在的原因。

.PARAMETER Path
settings.xml 路径（不存在或不是文件时返回空串，不抛异常：候选列表里天然会有不存在的路径）。

.OUTPUTS
System.String 仓库路径（原样，未规范化）；没有生效配置时返回空串。
#>
function Read-MavenSettingsLocalRepository {
    param([string]$Path = '')
    if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $raw = [System.IO.File]::ReadAllText($Path)
    $stripped = Remove-MavenSettingsComments $raw
    $matched = [System.Text.RegularExpressions.Regex]::Match($stripped, $script:MavenSettingsLocalRepositoryPattern)
    if (-not $matched.Success) { return '' }
    return $matched.Groups[1].Value.Trim()
}

<#
.SYNOPSIS
列出要检查的 settings.xml 路径（按优先级）。

.OUTPUTS
System.String[] 可能为空的路径列表（不保证文件存在）。
#>
function Get-MavenSettingsFileCandidates {
    $files = New-Object 'System.Collections.Generic.List[string]'
    if ($env:USERPROFILE) { $files.Add((Join-Path $env:USERPROFILE '.m2/settings.xml')) }
    foreach ($variable in @($env:MAVEN_HOME, $env:M2_HOME)) {
        if ($variable) { $files.Add((Join-Path $variable 'conf/settings.xml')) }
    }
    $mavenCommand = Get-Command 'mvn.cmd' -ErrorAction SilentlyContinue
    if (-not $mavenCommand) { $mavenCommand = Get-Command 'mvn' -ErrorAction SilentlyContinue }
    if ($mavenCommand -and $mavenCommand.Source) {
        $mavenRoot = Split-Path -Parent (Split-Path -Parent $mavenCommand.Source)
        $files.Add((Join-Path $mavenRoot 'conf/settings.xml'))
    }
    return $files.ToArray()
}

<#
.SYNOPSIS
给候选路径去重（大小写不敏感）并转成绝对路径。

.PARAMETER Paths
原始路径。

.PARAMETER Seen
调用方共享的去重集合（同一份解析里跨多次调用保持去重）。

.PARAMETER SearchLog
可选：解析过程记录（List/ArrayList 之类有 Add 方法的集合），用于失败时的可诊断输出。

.OUTPUTS
System.String[] 规范化后的路径列表。
#>
function Add-MavenRepositoryCandidate {
    param(
        [System.Collections.Generic.List[string]]$Target,
        [System.Collections.Generic.HashSet[string]]$Seen,
        [string]$Path = '',
        [string]$Origin = '',
        $SearchLog = $null
    )
    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    $full = [System.IO.Path]::GetFullPath($Path)
    if (-not $Seen.Add($full)) {
        if ($null -ne $SearchLog) { $SearchLog.Add("$Origin → $full（与前面重复，跳过）") | Out-Null }
        return
    }
    $Target.Add($full)
    if ($null -ne $SearchLog) { $SearchLog.Add("$Origin → $full") | Out-Null }
}

<#
.SYNOPSIS
按优先级列出所有可能的本地仓库（用于"在哪个仓库里找 jar"）。

.PARAMETER Explicit
调用方显式给的仓库（-LocalRepository）。给了就排第一，并记录到 SearchLog。

.PARAMETER SearchLog
可选：解析过程记录，元素是中文说明（失败时原样打印）。

.OUTPUTS
System.String[] 绝对路径列表，至少一个（最后一定是兜底的 $USERPROFILE/.m2/repository）。
#>
function Get-MavenRepositoryCandidates {
    param(
        [string]$Explicit = '',
        $SearchLog = $null
    )
    $target = New-Object 'System.Collections.Generic.List[string]'
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
    if ($Explicit) {
        Add-MavenRepositoryCandidate -Target $target -Seen $seen -Path $Explicit -Origin '参数 -LocalRepository 指定' -SearchLog $SearchLog
    }
    if ($env:MAVEN_REPO_LOCAL) {
        Add-MavenRepositoryCandidate -Target $target -Seen $seen -Path $env:MAVEN_REPO_LOCAL -Origin '环境变量 MAVEN_REPO_LOCAL' -SearchLog $SearchLog
    }
    if ($null -ne $SearchLog -and -not $Explicit -and -not $env:MAVEN_REPO_LOCAL) {
        $SearchLog.Add('未传 -LocalRepository 且没有 MAVEN_REPO_LOCAL → 退到 settings.xml / ~/.m2（构建期隔离仓库在这条路径上看不见）') | Out-Null
    }
    $settingsFiles = Get-MavenSettingsFileCandidates
    if ($settingsFiles.Count -eq 0 -and $SearchLog) {
        $SearchLog.Add('PATH 里没有 mvn.cmd / mvn → 少一处 settings.xml 候选（CI 用的就是仓库 wrapper）') | Out-Null
    }
    foreach ($settingsFile in $settingsFiles) {
        if (-not (Test-Path -LiteralPath $settingsFile -PathType Leaf)) {
            if ($null -ne $SearchLog) { $SearchLog.Add("settings 候选不存在: $settingsFile") | Out-Null }
            continue
        }
        $configured = Read-MavenSettingsLocalRepository -Path $settingsFile
        if ([string]::IsNullOrWhiteSpace($configured)) {
            if ($null -ne $SearchLog) { $SearchLog.Add("$settingsFile 存在但没有生效的 <localRepository>（注释里的示例不算）") | Out-Null }
            continue
        }
        Add-MavenRepositoryCandidate -Target $target -Seen $seen -Path $configured -Origin "$settingsFile 的 <localRepository>（已剥注释）" -SearchLog $SearchLog
    }
    $fallback = Join-Path $env:USERPROFILE '.m2/repository'
    Add-MavenRepositoryCandidate -Target $target -Seen $seen -Path $fallback -Origin '兜底（默认本地仓库）' -SearchLog $SearchLog
    return $target.ToArray()
}

<#
.SYNOPSIS
权威本地仓库（优先级最高的那一个）。

.DESCRIPTION
等于 Get-MavenRepositoryCandidates 的第一个元素：显式参数 > MAVEN_REPO_LOCAL >
settings.xml 的 <localRepository> > 兜底 ~/.m2/repository。

.PARAMETER Explicit
调用方显式给的仓库（-LocalRepository）。

.PARAMETER SearchLog
可选：解析过程记录。

.OUTPUTS
System.String 绝对路径。
#>
function Get-MavenLocalRepository {
    param(
        [string]$Explicit = '',
        $SearchLog = $null
    )
    $candidates = Get-MavenRepositoryCandidates -Explicit $Explicit -SearchLog $SearchLog
    if ($candidates.Count -eq 0) { return (Join-Path $env:USERPROFILE '.m2/repository') }
    return $candidates[0]
}