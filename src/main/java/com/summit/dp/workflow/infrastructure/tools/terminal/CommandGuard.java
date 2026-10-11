package com.summit.dp.workflow.infrastructure.tools.terminal;

import com.summit.core.runtime.workspace.ShellType;

import java.util.List;
import java.util.regex.Pattern;

/** 破坏性命令直接拒绝，可逆风险命令交给既有审批策略判定。 */
public final class CommandGuard {

    private CommandGuard() {
    }

    public enum Verdict {
        ALLOW,
        REQUIRES_APPROVAL,
        DESTRUCTIVE
    }

    // =====================================================================
    // Linux / Unix (bash / zsh / sh)
    // =====================================================================

    private static final List<Pattern> UNIX_DESTRUCTIVE = List.of(
            // filesystem creation / wipe tools
            Pattern.compile("(?i)\\b(?:mkfs(?:\\.\\w+)?|wipefs|shred)\\b"),
            // dd writing to a block device (tolerates quoted of= and non-leading variants)
            Pattern.compile("(?i)\\bdd\\b[^\\n]*\\bof=\\s*[\"']?/dev/(?:sd|hd|vd|nvme|mmcblk|dm-|md)\\d*"),
            // shell redirection into a block device, e.g. "cat x > /dev/sda"
            Pattern.compile("(?i)[>»][^\\n]*/dev/(?:sd|hd|vd|nvme|mmcblk|dm-|md)\\d*"),
            // shell redirection into key system directories
            Pattern.compile("(?i)[>»][^\\n]*/(?:etc|boot|root|proc)/"),
            // shutdown / reboot / runlevel switch
            Pattern.compile("(?i)\\b(?:shutdown|reboot|halt|poweroff|telinit)\\b"),
            Pattern.compile("(?i)\\binit\\s+[06]\\b"),
            Pattern.compile("(?i)\\bsystemctl\\s+(?:poweroff|reboot|halt|suspend|hibernate)\\b"),
            // fork bomb, e.g. ":(){ :|:& };:"
            Pattern.compile("(?i):\\s*\\(\\s*\\)\\s*\\{"),
            // remote download piped straight into a shell
            Pattern.compile("(?i)\\b(?:curl|wget|aria2c|lynx)\\b[^\\n]*\\|[^\\n]*\\b(?:sh|ba?sh|zsh|dash|fish)\\b"),
            // find -delete starting from the root directory
            Pattern.compile("(?i)\\bfind\\b[^\\n]*?\\s+[\"']?/(?:[^\\s\"']*/?)*[^\\n]*?\\s+-delete\\b")
    );

    /** 可逆风险命令仍由应用审批，不能在此直接放行。 */
    private static final List<Pattern> UNIX_REQUIRES_APPROVAL = List.of(
            // system / language package managers: lifecycle scripts can run arbitrary code
            Pattern.compile("(?i)\\bapk\\s+(?:add|del|fix|upgrade|update)\\b"),
            Pattern.compile("(?i)\\bapt(?:-get)?\\s+(?:install|remove|purge|upgrade|dist-upgrade|full-upgrade)\\b"),
            Pattern.compile("(?i)\\b(?:yum|dnf|zypper)\\s+(?:install|remove|erase|update|upgrade)\\b"),
            Pattern.compile("(?i)\\bpacman\\s+-(?:S|R|U)\\w*\\b"),
            Pattern.compile("(?i)\\b(?:npm|pnpm|yarn|bun)\\s+(?:i|install|add|remove|uninstall|update|upgrade)\\b"),
            Pattern.compile("(?i)\\b(?:pip|pip3|poetry|uv)\\s+(?:install|uninstall|add|remove|sync)\\b"),
            // chmod granting broad permissions on absolute paths
            Pattern.compile("(?i)\\bchmod\\b[^\\n]*\\b(?:777|0777|a\\+w|a\\+rwx|o\\+w)\\b[^\\n]*\\s[\"']?/"),
            // chown -R on an absolute path
            Pattern.compile("(?i)\\bchown\\b[^\\n]*\\s-r\\b[^\\n]*\\s[\"']?/"),
            // process termination
            Pattern.compile("(?i)\\b(?:pkill|killall)\\b|\\bkill\\s+(?:-[A-Z0-9]+\\s+)?(?:-?\\d+|\\$\\w+)")
    );

    private static final Pattern UNIX_RM_CMD = Pattern.compile("(?i)\\brm\\b");

    private static final Pattern UNIX_RM_FLAG = Pattern.compile("(?i)(?:^|\\s)-(?:\\S*[rR]\\S*)\\b|\\s--recursive\\b");

    private static final Pattern UNIX_RM_TARGET = Pattern.compile(
            "(?i)(?:^|[\\s\"'])(?:/[^\\s\"']*|~(?:/[^\\s\"']*)?|\\$HOME(?:/[^\\s\"']*)?)");

    // =====================================================================
    // Windows (cmd / PowerShell)
    // =====================================================================

    private static final List<Pattern> WINDOWS_DESTRUCTIVE = List.of(
            // formatting a drive letter (cmd format)
            Pattern.compile("(?i)\\bformat\\b[^\\n]*\\b[a-z]:(?:\\s|$)"),
            // PowerShell disk / volume destroying cmdlets
            Pattern.compile("(?i)\\b(?:Format-Volume|Clear-Disk|Clear-Volume|Initialize-Disk|Remove-PhysicalDisk)\\b"),
            // writing files into system directories
            Pattern.compile("(?i)\\b(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item)\\b[^\\n]*\\b[a-z]:\\\\(?:Windows|Program Files|ProgramData)\\b"),
            // system-wide registry modification
            Pattern.compile("(?i)\\breg\\s+(?:delete|add|copy|restore|save|load|unload)\\s+(?:HKLM|HKCR|HKU)\\b"),
            // executing downloaded content / Invoke-Expression
            Pattern.compile("(?i)\\b(?:Invoke-Expression|iex)\\b[^\\n]*(?:DownloadString|New-Object|curl|wget|iwr|Invoke-WebRequest|http)"),
            // shutdown / restart
            Pattern.compile("(?i)\\b(?:shutdown|Restart-Computer|Stop-Computer)\\b"),
            // disk partitioning tool (no legitimate agent use)
            Pattern.compile("(?i)\\bdiskpart\\b")
    );

    /** 可逆风险命令仍由应用审批，不能在此直接放行。 */
    private static final List<Pattern> WINDOWS_REQUIRES_APPROVAL = List.of(
            Pattern.compile("(?i)\\b(?:winget|choco|scoop)\\s+(?:install|uninstall|upgrade|update)\\b"),
            Pattern.compile("(?i)\\b(?:npm|pnpm|yarn|bun)\\s+(?:i|install|add|remove|uninstall|update|upgrade)\\b"),
            Pattern.compile("(?i)\\b(?:pip|pip3|poetry|uv)\\s+(?:install|uninstall|add|remove|sync)\\b"),
            // process / service termination
            Pattern.compile("(?i)\\bStop-Process\\b|\\btaskkill\\b|\\bStop-Service\\b")
    );

    private static final Pattern WIN_DELETE_CMD = Pattern.compile("(?i)\\b(?:Remove-Item|rm|ri|del|erase|rd|rmdir)\\b");

    private static final Pattern WIN_DELETE_FLAG = Pattern.compile(
            "(?i)(?:^|\\s)-(?:r\\b|recurse\\b|rec\\b|f\\b|fo\\b|force\\b)|(?:^|\\s)/(?:s|q|f)\\b");

    private static final Pattern WIN_DELETE_TARGET = Pattern.compile(
            "(?i)\\b[a-z]:\\\\(?:Windows|Program Files|ProgramData|Users)\\b|\\b[a-z]:\\\\[\"']?(?:\\s|$)");

    // =====================================================================
    // entry point
    // =====================================================================

    /** 未知 Shell 类型时同时应用两组规则，避免漏掉另一平台的危险命令。 */
    public static Verdict assess(String commandLine) {
        return assess(commandLine, null);
    }

    public static Verdict assess(String commandLine, ShellType shellType) {
        if (commandLine == null || commandLine.isBlank()) {
            return Verdict.ALLOW;
        }
        if (shellType == null) {
            return (destructive(commandLine, UNIX_DESTRUCTIVE, false)
                    || destructive(commandLine, WINDOWS_DESTRUCTIVE, true))
                    ? Verdict.DESTRUCTIVE
                    : (matchesAny(UNIX_REQUIRES_APPROVAL, commandLine)
                        || matchesAny(WINDOWS_REQUIRES_APPROVAL, commandLine)
                        ? Verdict.REQUIRES_APPROVAL : Verdict.ALLOW);
        }
        return switch (shellType) {
            case POWERSHELL, PWSH, CMD -> destructive(commandLine, WINDOWS_DESTRUCTIVE, true)
                    ? Verdict.DESTRUCTIVE
                    : (matchesAny(WINDOWS_REQUIRES_APPROVAL, commandLine)
                        ? Verdict.REQUIRES_APPROVAL : Verdict.ALLOW);
            case BASH, ZSH, SH -> destructive(commandLine, UNIX_DESTRUCTIVE, false)
                    ? Verdict.DESTRUCTIVE
                    : (matchesAny(UNIX_REQUIRES_APPROVAL, commandLine)
                        ? Verdict.REQUIRES_APPROVAL : Verdict.ALLOW);
        };
    }

    private static boolean destructive(String commandLine, List<Pattern> hardBlock, boolean windows) {
        if (matchesAny(hardBlock, commandLine)) {
            return true;
        }
        return windows ? isWindowsDelete(commandLine) : isUnixRmDelete(commandLine);
    }

    private static boolean matchesAny(List<Pattern> patterns, String commandLine) {
        for (Pattern pattern : patterns) {
            if (pattern.matcher(commandLine).find()) {
                return true;
            }
        }
        return false;
    }

    private static boolean isUnixRmDelete(String commandLine) {
        for (String segment : commandLine.split("(?:&&|\\|\\||;|\\r?\\n)+")) {
            if (UNIX_RM_CMD.matcher(segment).find()
                    && UNIX_RM_FLAG.matcher(segment).find()
                    && UNIX_RM_TARGET.matcher(segment).find()) {
                return true;
            }
        }
        return false;
    }

    private static boolean isWindowsDelete(String commandLine) {
        for (String segment : commandLine.split("(?:&&|\\|\\||;|\\r?\\n)+")) {
            if (WIN_DELETE_CMD.matcher(segment).find()
                    && WIN_DELETE_FLAG.matcher(segment).find()
                    && WIN_DELETE_TARGET.matcher(segment).find()) {
                return true;
            }
        }
        return false;
    }
}
