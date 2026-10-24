package com.summit.dp.tools.baseTools.terminal;

import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.OsType;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandShell;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 「这次命令用哪个解释器」只有一个解析入口，参数、检查、快照、恢复都取同一个答案。 */
class CommandShellTest {

    @Test
    void omittedShellUsesTheWorkspaceDefault() {
        assertEquals(ShellType.CMD, CommandShell.resolve(request(null), windows()));
        assertEquals(ShellType.BASH, CommandShell.resolve(request("  "), linux()));
    }

    @Test
    void requestedShellWinsOverTheWorkspaceDefault() {
        assertEquals(ShellType.PWSH, CommandShell.resolve(request("pwsh"), windows()));
        assertEquals(ShellType.POWERSHELL, CommandShell.resolve(request("powershell"), windows()));
        assertEquals(ShellType.SH, CommandShell.resolve(request("sh"), linux()));
    }

    @Test
    void unsupportedShellFailsInsteadOfFallingBack() {
        IllegalArgumentException failure = assertThrows(IllegalArgumentException.class,
                () -> CommandShell.resolve(request("bash"), windows()));
        assertEquals(true, failure.getMessage().contains("bash"), failure.getMessage());
    }

    @Test
    void missingWorkspaceCannotValidateAShell() {
        // 没有工作空间就没有平台信息：宁可明确拒绝，也不能猜一个解释器去执行。
        assertThrows(IllegalArgumentException.class, () -> CommandShell.resolve(request("pwsh"), null));
        assertNull(CommandShell.resolve(request(null), null));
    }

    private static ExecuteCommandRequest request(String shell) {
        return ExecuteCommandRequest.builder().command("echo hi").shell(shell).build();
    }

    private static Workspace windows() {
        return workspace(OsType.WINDOWS, ShellType.CMD);
    }

    private static Workspace linux() {
        return workspace(OsType.LINUX, ShellType.BASH);
    }

    private static Workspace workspace(OsType os, ShellType shell) {
        Workspace workspace = mock(Workspace.class);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder()
                .osType(os).shellType(shell).charset(StandardCharsets.UTF_8).build());
        return workspace;
    }
}
