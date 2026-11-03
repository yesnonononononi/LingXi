package com.summit.dp.sandbox_security.application;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** 风险只决定是否询问，批准后的执行链不再重复硬拒命令。 */
public final class CommandRiskClassifier {
    private static final Set<String> DISK_TOOLS = Set.of("mkfs", "wipefs", "diskpart", "format",
            "format-volume", "clear-disk", "clear-volume", "initialize-disk", "remove-physicaldisk");
    private static final Set<String> SYSTEM_TOOLS = Set.of("wsl", "wslconfig", "shutdown", "reboot", "halt",
            "poweroff", "telinit", "restart-computer", "stop-computer");
    private static final Set<String> DELETE_TOOLS = Set.of("rm", "rmdir", "rd", "del", "erase", "remove-item", "ri");
    private static final Set<String> SHELLS = Set.of("cmd", "powershell", "pwsh", "bash", "sh", "zsh", "dash");
    private static final Set<String> WRAPPERS = Set.of("sudo", "doas", "env", "nohup", "command", "exec", "start", "start-process");
    private static final Set<String> PACKAGE_MANAGERS = Set.of("apk", "apt", "apt-get", "yum", "dnf", "zypper",
            "pacman", "npm", "pnpm", "yarn", "bun", "pip", "pip3", "poetry", "uv", "winget", "choco", "scoop");
    private static final Set<String> PACKAGE_ACTIONS = Set.of("i", "install", "add", "remove", "uninstall", "update",
            "upgrade", "sync", "purge", "erase", "del", "fix", "dist-upgrade", "full-upgrade");
    private static final Set<String> PROCESS_TOOLS = Set.of("kill", "pkill", "killall", "stop-process", "taskkill", "stop-service");
    private static final Set<String> DOWNLOAD_TOOLS = Set.of("curl", "wget", "aria2c", "lynx", "iwr", "invoke-webrequest");

    private CommandRiskClassifier() { }

    public enum Risk { NORMAL, ELEVATED, CRITICAL }

    public static Risk assess(String command) {
        return assess(command, 0);
    }

    private static Risk assess(String command, int depth) {
        if (command == null || command.isBlank()) return Risk.NORMAL;
        Risk result = Risk.NORMAL;
        boolean downloaded = false;
        for (List<CommandScriptTokens.Token> segment : CommandScriptTokens.parse(command)) {
            for (int index = 0; index + 1 < segment.size(); index++) {
                if (segment.get(index).outputRedirect() && isDevice(segment.get(index + 1).text())) return Risk.CRITICAL;
            }
            List<String> tokens = segment.stream().map(CommandScriptTokens.Token::text).toList();
            Risk risk = assessTokens(tokens, depth);
            if (risk == Risk.CRITICAL) return risk;
            String program = normalizeProgram(tokens.getFirst());
            if (risk == Risk.ELEVATED || downloaded && (SHELLS.contains(program) || Set.of("iex", "invoke-expression").contains(program))) {
                result = Risk.ELEVATED;
            }
            if (DOWNLOAD_TOOLS.contains(program)) downloaded = true;
        }
        return result;
    }

    private static Risk assessTokens(List<String> tokens, int depth) {
        if (tokens.isEmpty()) return Risk.NORMAL;
        String program = normalizeProgram(tokens.getFirst());
        List<String> arguments = tokens.subList(1, tokens.size());
        if (program.startsWith(":()")) return Risk.CRITICAL;
        // 引号内的检索文本不能当作命令；只解析实际命令及显式解释器包装。
        if (depth < 8 && SHELLS.contains(program)) {
            for (int index = 0; index < arguments.size(); index++) {
                String option = arguments.get(index).toLowerCase(Locale.ROOT);
                if (Set.of("/c", "/k", "-c", "-command").contains(option)) {
                    return assess(String.join(" ", arguments.subList(index + 1, arguments.size())), depth + 1);
                }
            }
        }
        if (depth < 8 && WRAPPERS.contains(program)) {
            if (program.equals("start-process") && arguments.stream().anyMatch(value -> value.equalsIgnoreCase("RunAs"))) {
                return Risk.CRITICAL;
            }
            for (int index = 0; index < arguments.size(); index++) {
                String value = arguments.get(index);
                if (Set.of("-u", "-g", "--user", "--group").contains(value)) { index++; continue; }
                if (value.isBlank() || value.startsWith("-") || value.startsWith("/") && program.equals("start")
                        || program.equals("env") && value.contains("=")) continue;
                return assessTokens(arguments.subList(index, arguments.size()), depth + 1);
            }
        }
        if (SYSTEM_TOOLS.contains(program)) return Risk.CRITICAL;
        if (arguments.stream().anyMatch(value -> Set.of("--help", "-h", "/?").contains(value))) return Risk.NORMAL;
        if (DISK_TOOLS.contains(program) || program.startsWith("mkfs.")) return Risk.CRITICAL;
        if (program.equals("dd") && arguments.stream().anyMatch(value -> value.startsWith("of=") && isDevice(value.substring(3)))) {
            return Risk.CRITICAL;
        }
        if (program.equals("shred")) {
            return arguments.stream().anyMatch(value -> isDevice(value) || isCriticalTarget(value)) ? Risk.CRITICAL : Risk.ELEVATED;
        }
        if (DELETE_TOOLS.contains(program) || program.equals("find") && arguments.contains("-delete")) {
            return arguments.stream().anyMatch(CommandRiskClassifier::isCriticalTarget) ? Risk.CRITICAL : Risk.ELEVATED;
        }
        if (program.equals("systemctl") && arguments.stream().anyMatch(value -> Set.of("poweroff", "reboot", "halt", "suspend", "hibernate").contains(value))) {
            return Risk.CRITICAL;
        }
        if (program.equals("init") && arguments.stream().anyMatch(value -> value.equals("0") || value.equals("6"))) return Risk.CRITICAL;
        if (program.equals("chmod") || program.equals("chown")) {
            return arguments.stream().anyMatch(CommandRiskClassifier::isCriticalTarget) ? Risk.CRITICAL : Risk.ELEVATED;
        }
        if (PROCESS_TOOLS.contains(program)) return Risk.ELEVATED;
        if (PACKAGE_MANAGERS.contains(program) && arguments.stream().anyMatch(value -> PACKAGE_ACTIONS.contains(value.toLowerCase(Locale.ROOT))
                || program.equals("pacman") && value.matches("-[SRU].*"))) return Risk.ELEVATED;
        return Risk.NORMAL;
    }

    private static boolean isDevice(String target) {
        String path = target.replace('\\', '/').toLowerCase(Locale.ROOT);
        return path.matches("/dev/(?:sd|hd|vd|nvme|mmcblk|dm-|md).*") || path.startsWith("//./physicaldrive");
    }

    private static boolean isCriticalTarget(String target) {
        String path = normalizeTarget(target);
        if (Set.of("/", "~", "$home", "${home}", "$env:userprofile", "%userprofile%", "$env:systemdrive", "%systemdrive%").contains(path)) return true;
        if (path.matches("/(?:[^/]*[?*][^/]*)") || path.matches("[a-z]:/(?:[^/]*[?*][^/]*)")) return true;
        if (path.matches("[a-z]:/?") || path.matches("[a-z]:/(?:windows|users|program files|program files \\(x86\\)|programdata)")) return true;
        if (path.matches("[a-z]:/users/[^/]+") || path.matches("/(?:home|users)/[^/]+")) return true;
        return path.matches("/(?:etc|boot|root|proc|sys|dev)(?:/.*)?") || path.matches("/(?:usr|var|bin|sbin|lib|lib64|home|users)")
                || path.matches("[a-z]:/windows/.*") || path.matches("(?:%systemroot%|%windir%|\\$env:windir|\\$env:systemroot)(?:/.*)?");
    }

    private static String normalizeTarget(String target) {
        String path = target.replace('\\', '/').toLowerCase(Locale.ROOT).replaceFirst("^//\\?/", "");
        List<String> parts = new ArrayList<>();
        for (String part : path.split("/+")) {
            if (part.equals(".") || part.isEmpty()) continue;
            if (part.equals("..") && !parts.isEmpty()) parts.removeLast();
            else parts.add(part);
        }
        while (!parts.isEmpty() && Set.of("*", "*.*").contains(parts.getLast())) parts.removeLast();
        return (path.startsWith("/") ? "/" : "") + String.join("/", parts);
    }

    private static String normalizeProgram(String token) {
        String path = token.replace('\\', '/');
        return path.substring(path.lastIndexOf('/') + 1).replaceFirst("(?i)\\.(?:exe|com|cmd|bat)$", "").toLowerCase(Locale.ROOT);
    }
}
