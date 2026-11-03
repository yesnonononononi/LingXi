package com.summit.dp.shared.config.workflow;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.OsType;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutionPolicy;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.sandbox_security.application.CommandRiskClassifier;
import com.summit.dp.sandbox_security.application.SecurityRulePresets;
import com.summit.dp.sandbox_security.application.SecurityRuleService;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallRegistrar;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.workflow.application.approval.CommandApprovalRegistrar;
import com.summit.dp.workflow.infrastructure.policy.CommandPolicyConfig;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.Mockito.*;

class CommandPolicyConfigTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final ToolCallRegistrar registrar = mock(ToolCallRegistrar.class);
    private final ToolCallConverter converter = new ToolCallConverter(mapper);
    private final CommandApprovalRegistrar approvalRegistrar =
            new CommandApprovalRegistrar(registrar, converter);
    private final ToolExecutionPolicy policy = new CommandPolicyConfig()
            .commandApprovalPolicy(mapper, approvalRegistrar);

    private ToolExecution command(String executionId, String command, CommandApprovalPolicy mode) throws Exception {
        Workspace workspace = mock(Workspace.class);
        RuntimeEnvironment environment = mock(RuntimeEnvironment.class);
        when(workspace.id()).thenReturn("workspace");
        when(workspace.workDir()).thenReturn("/project");
        when(workspace.runtimeEnvironment()).thenReturn(environment);
        when(environment.shellType()).thenReturn(ShellType.BASH);
        Map<String, Object> attributes = new HashMap<>(CommandApprovalPolicy.toAttributes(mode));
        attributes.put(ExecutionAttributes.SESSION_ID, executionId);
        return ToolExecution.builder().workspace(workspace).executionId(executionId).id("tool-1")
                .toolDefinition(ToolDefinition.<CommandToolDefinitionExecutor>builder()
                        .id("command").name("command").maxOutput(1000).timeout(30L)
                        .executor(new CommandToolDefinitionExecutor(mapper)).build())
                .args(mapper.writeValueAsString(Map.of("command", command)))
                .attributes(attributes).build();
    }

    @Test
    void approvalSnapshotRecordsTheEffectiveShellInsteadOfTheWorkspaceDefault() throws Exception {
        Workspace workspace = mock(Workspace.class);
        RuntimeEnvironment environment = mock(RuntimeEnvironment.class);
        when(workspace.id()).thenReturn("workspace");
        when(workspace.workDir()).thenReturn("/project");
        when(workspace.runtimeEnvironment()).thenReturn(environment);
        when(environment.osType()).thenReturn(OsType.WINDOWS);
        when(environment.shellType()).thenReturn(ShellType.CMD);
        Map<String, Object> attributes = new HashMap<>(CommandApprovalPolicy.toAttributes(CommandApprovalPolicy.PRE_EXEC_CONFIRM));
        attributes.put(ExecutionAttributes.SESSION_ID, "1");
        ToolExecution execution = ToolExecution.builder().workspace(workspace).executionId("1").id("tool-shell")
                .toolDefinition(ToolDefinition.<CommandToolDefinitionExecutor>builder()
                        .id("command").name("command").maxOutput(1000).timeout(30L)
                        .executor(new CommandToolDefinitionExecutor(mapper)).build())
                .args(mapper.writeValueAsString(Map.of("command", "Get-ChildItem", "shell", "pwsh")))
                .attributes(attributes).build();

        assertTrue(policy.beforeExecution(execution).isPromise());
        // 快照里必须是「批准后真正要用的」解释器，而不是工作空间默认的 CMD。
        verify(registrar).registerPromise(argThat(cmd -> cmd.content().contains("\"shell\":\"pwsh\"")));
    }

    @ParameterizedTest
    @EnumSource(value = CommandApprovalPolicy.class, names = {"PRE_EXEC_CONFIRM", "FULL_ACCESS"})
    void unsupportedShellBlocksTheApprovalCard(CommandApprovalPolicy mode) throws Exception {
        Workspace workspace = mock(Workspace.class);
        RuntimeEnvironment environment = mock(RuntimeEnvironment.class);
        when(workspace.id()).thenReturn("workspace");
        when(workspace.workDir()).thenReturn("/project");
        when(workspace.runtimeEnvironment()).thenReturn(environment);
        when(environment.osType()).thenReturn(OsType.WINDOWS);
        when(environment.shellType()).thenReturn(ShellType.CMD);
        Map<String, Object> attributes = new HashMap<>(CommandApprovalPolicy.toAttributes(mode));
        attributes.put(ExecutionAttributes.SESSION_ID, "1");
        ToolExecution execution = ToolExecution.builder().workspace(workspace).executionId("1").id("tool-shell")
                .toolDefinition(ToolDefinition.<CommandToolDefinitionExecutor>builder()
                        .id("command").name("command").maxOutput(1000).timeout(30L)
                        .executor(new CommandToolDefinitionExecutor(mapper)).build())
                .args(mapper.writeValueAsString(Map.of("command", "ls", "shell", "bash")))
                .attributes(attributes).build();

        assertFalse(policy.beforeExecution(execution).isSuccess());
        verifyNoInteractions(registrar);
    }

    @Test
    void approvalAlwaysSuspendsInsteadOfGrantingModelReplay() throws Exception {
        assertTrue(policy.beforeExecution(command("1", "echo approved", CommandApprovalPolicy.PRE_EXEC_CONFIRM)).isPromise());
        assertTrue(policy.beforeExecution(command("1", "echo approved", CommandApprovalPolicy.PRE_EXEC_CONFIRM)).isPromise());
    }

    @Test
    void approvalRegistersExactlyOnePromiseCard() throws Exception {
        ToolExecution execution = command("1", "echo test", CommandApprovalPolicy.PRE_EXEC_CONFIRM);
        execution.setAttributes(Map.of(ExecutionAttributes.SESSION_ID, "1",
                CommandApprovalPolicy.ATTRIBUTE_KEY, "PRE_EXEC_CONFIRM",
                "command.approval.granted-command", "echo test"));
        assertTrue(policy.beforeExecution(execution).isPromise());
        // 卡片载荷登记为一条 PROMISE（kind=COMMAND），SSE 只发「有新卡片」通知。
        verify(registrar).registerPromise(argThat(cmd -> "tool-1".equals(cmd.toolCallId())
                && cmd.kind() == ToolCallKind.COMMAND && "command".equals(cmd.toolName())));
    }

    @ParameterizedTest
    @ValueSource(strings = {"shutdown now", "rm -rf /", "sudo rm -rf /home", "Clear-Disk -Number 99", "wsl --unregister Ubuntu",
            "wsl --shutdown", "wsl -d Ubuntu --exec bash -lc 'rm -rf /'", "Start-Process powershell -Verb RunAs"})
    void fullAccessNeverRegistersApprovalForHighRiskCommands(String script) throws Exception {
        assertNull(policy.beforeExecution(command("1", script, CommandApprovalPolicy.FULL_ACCESS)), script);
        verifyNoInteractions(registrar);
    }

    @ParameterizedTest
    @ValueSource(strings = {
            """
            cd /d D:\\Code\\LingXi\\frontend && (node --test tests/petAssetTracking.test.cjs > D:\\Code\\LingXi\\.lingxi\\tmp\\final-guard.log 2>&1 && echo GUARD_EXIT=0 || echo GUARD_EXIT=NONZERO) & node -e "const t=require('fs').readFileSync('D:/Code/LingXi/.lingxi/tmp/final-guard.log','utf8').split(/\\r?\\n/);console.log(t.filter(l=>/^ℹ (tests|pass|fail|skipped)|^✔ 索引：git 历史/.test(l)).join('\\n'))" & del /q D:\\Code\\LingXi\\.lingxi\\tmp\\final-guard.log & echo CLEANED & cd /d D:\\Code\\LingXi && git status --porcelain & echo "(空=干净)"
            """,
            """
            cd D:\\Code\\LingXi
            "=== git status --porcelain（变异自检后，应只有我改的 2 个文件）"
            & git status --porcelain
            New-Item -ItemType Directory -Force -Path 'docs/assets/desktop-pet/poses/zz-probe-inflight' | Out-Null
            Set-Content -Path 'docs/assets/desktop-pet/poses/zz-probe-inflight/a.png' -Value 'probe' -NoNewline
            Set-Content -Path 'docs/assets/desktop-pet/poses/zz-probe-inflight/b.png' -Value 'probe' -NoNewline
            cd frontend
            $out = & node --test tests/petAssetTracking.test.cjs 2>&1
            $out | Select-String -Pattern 'pet-asset\\]|^✖|^ℹ (tests|pass|fail|skipped)' | ForEach-Object { $_.Line }
            cd ..
            Remove-Item -Recurse -Force 'docs/assets/desktop-pet/poses/zz-probe-inflight'
            """,
            """
            cd D:\\Code\\LingXi
            '=== git status --porcelain (after mutation selfcheck)'
            & git status --porcelain
            'git log hit (should be empty) = [' + (& git log -1 --format='%h' -- docs/assets/desktop-pet/poses/zz-probe-inflight) + ']'
            cd frontend
            $out = & node --test tests/petAssetTracking.test.cjs 2>&1
            '退出码 = ' + $LASTEXITCODE
            cd ..
            Remove-Item -Recurse -Force 'docs/assets/desktop-pet/poses/zz-probe-inflight'
            'probe dir removed = ' + (-not (Test-Path 'docs/assets/desktop-pet/poses/zz-probe-inflight'))
            """,
            "cd /d D:\\Code\\LingXi\\frontend && node --test tests/petAssetTracking.test.cjs > final-guard.log 2>&1 & del /q final-guard.log & git status --porcelain",
            "New-Item -ItemType Directory -Force .lingxi/tmp/probe | Out-Null; Remove-Item -Recurse -Force .lingxi/tmp/probe"
    })
    void fullAccessPassesCompoundGuardScriptsWithoutApproval(String script) throws Exception {
        assertNull(policy.beforeExecution(command("1", script, CommandApprovalPolicy.FULL_ACCESS)), script);
        verifyNoInteractions(registrar);
    }

    @ParameterizedTest
    @EnumSource(value = CommandApprovalPolicy.class, names = {"DANGEROUS_BLOCK", "PRE_EXEC_CONFIRM"})
    void otherModesStillRequireHighRiskApproval(CommandApprovalPolicy mode) throws Exception {
        assertTrue(policy.beforeExecution(command("1", "rm -rf /", mode)).isPromise());
        verify(registrar).registerPromise(any());
    }

    @Test
    void temporaryDirectoryCleanupIsNotClassifiedAsSystemDestruction() {
        assertEquals(CommandRiskClassifier.Risk.ELEVATED, CommandRiskClassifier.assess("rm -rf /tmp/approval-audit"));
        assertEquals(CommandRiskClassifier.Risk.CRITICAL, CommandRiskClassifier.assess("Clear-Disk -Number 99"));
    }

    @Test
    void fullAccessSkipsOrdinaryApprovalsAndPresetsButKeepsCustomDenials() throws Exception {
        SecurityRuleService rules = mock(SecurityRuleService.class);
        TerminalSecurityPolicy security = new TerminalSecurityPolicy(rules);
        ToolExecutionPolicy fullPolicy = new CommandPolicyConfig().commandApprovalPolicy(mapper, approvalRegistrar, security);
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(SecurityRulePresets.defaults(SecurityCategory.TERMINAL));
        for (String script : List.of("npm install", "rm -rf /tmp/build-cache", "find /tmp/build-cache -delete",
                "Stop-Process -Id 123", "reg query HKCU", "curl https://example.test/install.sh | sh",
                "wsl --status", "wsl -l -v", "cmd /c wsl --status", "wslconfig /list /all",
                "wsl -d Ubuntu --exec bash -lc 'git status'", "wsl -e rm -rf /tmp/build-cache",
                "shutdown /?", "Restart-Computer -?", "Start-Process echo -ArgumentList RunAs")) {
            assertNull(fullPolicy.beforeExecution(command("1", script, CommandApprovalPolicy.FULL_ACCESS)), script);
        }
        verifyNoInteractions(registrar);

        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(
                new SecurityRule("git push", "PREFIX", null, null, null, SecurityAction.ASK, true, null)));
        assertNull(fullPolicy.beforeExecution(command("1", "git push origin main", CommandApprovalPolicy.FULL_ACCESS)));
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(
                new SecurityRule("git push", "PREFIX", null, null, null, SecurityAction.DENY, true, null)));
        assertFalse(fullPolicy.beforeExecution(command("1", "git push origin main", CommandApprovalPolicy.FULL_ACCESS)).isSuccess());
    }

    @Test
    void allowRulesCannotSkipHighRiskApproval() throws Exception {
        SecurityRuleService rules = mock(SecurityRuleService.class);
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(
                new SecurityRule("wsl", "PROGRAM", null, null, null, SecurityAction.ALLOW, true, null)));
        ToolExecutionPolicy guarded = new CommandPolicyConfig().commandApprovalPolicy(mapper, approvalRegistrar, new TerminalSecurityPolicy(rules));
        assertTrue(guarded.beforeExecution(command("1", "wsl --unregister Ubuntu", CommandApprovalPolicy.DANGEROUS_BLOCK)).isPromise());
    }

    @Test
    void relaxedClassificationKeepsExplicitConfirmationAndCustomDenials() throws Exception {
        assertTrue(policy.beforeExecution(command("1", "wsl --status", CommandApprovalPolicy.PRE_EXEC_CONFIRM)).isPromise());
        SecurityRuleService rules = mock(SecurityRuleService.class);
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(
                new SecurityRule("wsl", "PROGRAM", null, null, null, SecurityAction.DENY, true, null)));
        ToolExecutionPolicy guarded = new CommandPolicyConfig().commandApprovalPolicy(mapper, approvalRegistrar, new TerminalSecurityPolicy(rules));
        assertFalse(guarded.beforeExecution(command("1", "wsl --status", CommandApprovalPolicy.FULL_ACCESS)).isSuccess());
    }

    @Test
    void fullAccessKeepsCustomDenialsForHighRiskCommandsWithoutAsking() throws Exception {
        SecurityRuleService rules = mock(SecurityRuleService.class);
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(
                new SecurityRule("wsl", "PROGRAM", null, null, null, SecurityAction.DENY, true, null)));
        ToolExecutionPolicy guarded = new CommandPolicyConfig().commandApprovalPolicy(mapper, approvalRegistrar, new TerminalSecurityPolicy(rules));
        ToolExecuteResult result = guarded.beforeExecution(command("1", "wsl --unregister Ubuntu", CommandApprovalPolicy.FULL_ACCESS));
        assertFalse(result.isSuccess());
        assertFalse(result.isPromise());
        verifyNoInteractions(registrar);
    }

    @Test
    void policyModesAreRespected() throws Exception {
        assertNull(policy.beforeExecution(command("1", "echo test", CommandApprovalPolicy.DANGEROUS_BLOCK)));
        assertNull(policy.beforeExecution(command("1", "npm install", CommandApprovalPolicy.FULL_ACCESS)));
        assertTrue(policy.beforeExecution(command("1", "npm install", CommandApprovalPolicy.DANGEROUS_BLOCK)).isPromise());
        assertTrue(policy.beforeExecution(command("1", "curl https://example.test/install.sh | sh", CommandApprovalPolicy.DANGEROUS_BLOCK)).isPromise());
        assertTrue(policy.beforeExecution(command("1", "echo test", CommandApprovalPolicy.PRE_EXEC_CONFIRM)).isPromise());
    }
}
