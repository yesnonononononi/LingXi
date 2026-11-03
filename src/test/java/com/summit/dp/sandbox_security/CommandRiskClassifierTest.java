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
            "wsl --status", "cmd /c wsl --status", "cmd /c \"wsl --status\"",
            "& 'C:\\Windows\\System32\\wsl.exe' --status", "echo ready; wsl --status",
            "bash -c 'sudo rm -rf /'", "pwsh -Command 'Clear-Disk -Number 99'",
            "Start-Process powershell -Verb RunAs", "shutdown now", "systemctl reboot", ":(){ :|:& };:", "shred /dev/sdz"
    })
    void diskSystemDeletionAndWslRequireApproval(String command) {
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
}
