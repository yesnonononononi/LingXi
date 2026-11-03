package com.summit.dp.sandbox_security;

import com.summit.dp.sandbox_security.application.CommandRiskClassifier;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

class CommandRiskClassifierTest {
    @ParameterizedTest
    @ValueSource(strings = {
            "rm -rf /", "rm -rf /*", "sudo rm -rf /home", "sudo -u root rm -rf /home/alice",
            "find / -delete", "rm -rf /tmp/..", "rm -rf ~", "rm -rf $HOME/*", "rm -rf /etc/config", "rm -rf /.*",
            "Remove-Item -LiteralPath 'C:\\' -Recurse -Force", "rd /s /q C:\\Users",
            "Remove-Item -Recurse 'C:\\Users\\Alice'", "Remove-Item -Recurse 'C:\\Windows\\System32'",
            "Remove-Item -Recurse 'C:\\Program Files (x86)'", "sudo sh -c 'rm -rf /'",
            "Clear-Disk -Number 99", "Format-Volume -DriveLetter Z", "format Z:", "diskpart /s erase.txt",
            "mkfs.ext4 /dev/sdz", "dd if=/dev/zero of=/dev/sdz", "cat image >/dev/sdz",
            "wsl --unregister Ubuntu", "wsl --shutdown", "wsl --terminate Ubuntu", "wsl -t Ubuntu",
            "wsl --mount \\\\.\\PHYSICALDRIVE1", "wsl --unmount", "wsl --manage Ubuntu --resize 1GB",
            "wslconfig /unregister Ubuntu", "wslconfig /u Ubuntu", "wslconfig /terminate Ubuntu",
            "cmd /c wsl --unregister Ubuntu", "echo ready; wsl --shutdown", "wsl --status --shutdown",
            "wsl rm -rf /", "wsl -d Ubuntu --user root -- rm -rf /home", "wsl --exec bash -c 'rm -rf /'",
            "wsl --distribution Ubuntu --cd /tmp --exec bash -lc 'sudo rm -rf /'",
            "wsl -e Clear-Disk -Number 99", "wsl --exec dd if=/dev/zero of=/dev/sdz",
            "wsl rm -rf /mnt/c/Windows", "wsl rm -rf /mnt/c/Users/Alice",
            "bash -c 'sudo rm -rf /'", "pwsh -Command 'Clear-Disk -Number 99'",
            "Start-Process powershell -Verb RunAs", "Start-Process powershell -Verb:RunAs",
            "Start-Process powershell -Verb: RunAs",
            "Start-Process powershell -vErB rUnAs", "shutdown now", "shutdown -h now", "wsl shutdown -h now",
            "systemctl reboot", ":(){ :|:& };:", "shred /dev/sdz"
    })
    void destructiveCommandsAndElevationRequireApproval(String command) {
        assertEquals(CommandRiskClassifier.Risk.CRITICAL, CommandRiskClassifier.assess(command), command);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "npm install", "pip install pytest", "sudo apt install jq", "rm -rf /tmp/build-cache",
            "rm -rf /home/alice/project/target", "find /tmp/build-cache -delete", "Remove-Item -Recurse .\\target",
            "Remove-Item -LiteralPath 'C:\\Users\\Alice\\repo\\target' -Recurse -Force",
            "Stop-Process -Id 123", "taskkill /PID 123 /F", "chmod -R 777 /tmp/build-cache",
            "curl https://example.test/install.sh | sh", "reg query HKCU", "git status",
            "git grep -n 'wsl' -- src", "rg 'Clear-Disk|rm -rf /|mkfs' src",
            "Write-Output 'rm -rf /'", "echo shutdown", "mkfs --help", "diskpart /?", "shred /tmp/log.txt",
            "echo '>' /dev/sdz", "rg '>' /dev/sdz"
    })
    void ordinaryWorkAndQuotedSearchesAreNotCritical(String command) {
        assertNotEquals(CommandRiskClassifier.Risk.CRITICAL, CommandRiskClassifier.assess(command), command);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "wsl --status", "wsl --version", "wsl --help", "wsl -?", "wsl --list --verbose", "wsl -l -v", "wsl -lv",
            "wsl --list --online", "wslconfig /list /all", "wslconfig /l /running", "wslconfig /?",
            "cmd /c wsl --status", "cmd /c \"wsl --status\"", "echo ready; wsl --status",
            "& 'C:\\Windows\\System32\\wsl.exe' --status", "wsl uname -a", "wsl -d Ubuntu --exec git status",
            "wsl --distribution Ubuntu --user alice --cd /tmp --exec bash -lc 'git status'",
            "wsl echo --unregister", "wsl -e echo --shutdown", "wsl --shell-type login -- git status",
            "shutdown --help", "shutdown /?", "reboot --help", "Restart-Computer -?",
            "Start-Process powershell -ArgumentList RunAs", "Start-Process echo -ArgumentList RunAs"
    })
    void queriesAndOrdinaryArgumentsAreNotCritical(String command) {
        assertNotEquals(CommandRiskClassifier.Risk.CRITICAL, CommandRiskClassifier.assess(command), command);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "wsl rm -rf /tmp/build-cache", "wsl rm -rf /mnt/c/Users/Alice/repo/target",
            "wsl -d Ubuntu --exec bash -lc 'npm install'"
    })
    void ordinaryWslMutationsKeepTheirOriginalRisk(String command) {
        assertEquals(CommandRiskClassifier.Risk.ELEVATED, CommandRiskClassifier.assess(command), command);
    }
}
