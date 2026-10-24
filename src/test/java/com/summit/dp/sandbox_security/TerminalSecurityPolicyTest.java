package com.summit.dp.sandbox_security;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.sandbox_security.application.SecurityRulePresets;
import com.summit.dp.sandbox_security.application.SecurityRuleService;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;
import com.summit.dp.sandbox_security.domain.model.SecurityCategory;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.workflow.application.approval.CommandApprovalRegistrar;
import com.summit.dp.workflow.infrastructure.policy.CommandPolicyConfig;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.Test;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class TerminalSecurityPolicyTest {
    private final SecurityRuleService rules = mock(SecurityRuleService.class);
    private final TerminalSecurityPolicy policy = new TerminalSecurityPolicy(rules);
    private final ObjectMapper mapper = new ObjectMapper();
    private SecurityRule rule(String pattern, String type, SecurityAction action) {
        return new SecurityRule(pattern, type, null, null, null, action, true, null);
    }
    @Test void denyOverridesAllowAndProgramMatchesAbsoluteQuotedPathsAndChains() {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(
                rule("git", "PREFIX", SecurityAction.ALLOW), rule("reg", "PROGRAM", SecurityAction.DENY)));
        for (String command : List.of("reg query HKCU", "git status & reg.exe query HKCU", "\"C:\\Windows\\System32\\reg.exe\" query HKCU")) {
            assertEquals(SecurityAction.DENY, policy.evaluate(command).action(), command);
        }
        assertNull(policy.evaluate("registry-tool"));
        assertEquals(SecurityAction.ALLOW, policy.evaluate("git status").action());
        assertNull(policy.evaluate("github status"));
    }
    @Test void deniedPrefixAlsoMatchesImmediateShellOperators() {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(rule("git push", "PREFIX", SecurityAction.DENY)));
        for (String command : List.of("git push&echo done", "git push>result.txt", "git push origin main")) {
            assertEquals(SecurityAction.DENY, policy.evaluate(command).action(), command);
        }
        assertNull(policy.evaluate("git push-other"));
    }
    @Test void askRegistersApprovalAndAllowSkipsGlobalConfirmation() throws Exception {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(rule("git push", "PREFIX", SecurityAction.ASK)));
        CommandApprovalRegistrar registrar = mock(CommandApprovalRegistrar.class);
        ToolExecution call = call("git push origin main");
        ToolExecuteResult result = new CommandPolicyConfig().commandApprovalPolicy(mapper, registrar, policy).beforeExecution(call);
        assertTrue(result.isPromise());
        verify(registrar).register(call, "git push origin main", ShellType.CMD);
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(rule("git push", "PREFIX", SecurityAction.ALLOW)));
        assertNull(new CommandPolicyConfig().commandApprovalPolicy(mapper, registrar, policy).beforeExecution(call));
    }
    @Test void replayRechecksLatestDenialBeforeStartingAProcess() throws Exception {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(rule("echo", "PREFIX", SecurityAction.DENY)));
        ToolExecution call = call("echo approved-earlier");
        ToolExecuteResult result = new CommandToolDefinitionExecutor(mapper, policy).execute(call);
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("安全规则"));
        verifyNoInteractions(call.getWorkspace().bridge());
    }
    @Test void programNameInsideQuotedArgumentsIsNotExecution() {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(rule("reg", "PROGRAM", SecurityAction.DENY)));
        for (String command : List.of(
                "git grep -n \"reg\" -- src/main",
                "Select-String -Path a.java -Pattern 'reg'",
                "type reg-notes.txt",
                "echo done > reg.log")) {
            assertNull(policy.evaluate(command), command);
        }
    }
    @Test void programInCommandPositionIsStillDenied() {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(rule("reg", "PROGRAM", SecurityAction.DENY)));
        for (String command : List.of(
                "reg query HKCU",
                "reg.exe query HKCU",
                "git status & reg query HKCU",
                "cmd /c reg query HKCU",
                "start reg")) {
            assertEquals(SecurityAction.DENY, policy.evaluate(command).action(), command);
        }
    }
    @Test void unquotedMentionOutsideCommandPositionStaysDeniedOnPurpose() {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(rule("reg", "PROGRAM", SecurityAction.DENY)));
        // 保守取舍：只是打印程序名并不会执行它，但规则不区分，宁可多拦。
        assertEquals(SecurityAction.DENY, policy.evaluate("echo reg").action());
    }
    @Test void denialExplainsWhichRuleAndHowToAdjustIt() {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(List.of(
                new SecurityRule("reg", "PROGRAM", null, null, null, SecurityAction.DENY, true, "reg")));
        SecurityDecision decision = policy.evaluate("reg query HKCU");
        assertTrue(decision.describe().contains("reg"), decision.describe());
        assertTrue(decision.describe().contains("程序匹配"), decision.describe());
        assertTrue(decision.describe().contains("预设规则"), decision.describe());
        assertTrue(decision.describe().contains("安全规则"), decision.describe());
        assertTrue(decision.describe().contains("设置中调整"), decision.describe());
        assertFalse(decision.describe().contains("自定义"), decision.describe());
    }
    @Test void defaultTerminalPresetsAllowSearchingTheDeniedProgramNames() {
        when(rules.rules(SecurityCategory.TERMINAL)).thenReturn(SecurityRulePresets.defaults(SecurityCategory.TERMINAL));
        // 之前这类只读检索会因为命令里出现程序名而被整条拒绝，连「为什么被拒」都查不了。
        assertNull(policy.evaluate("git grep -n \"wsl\" -- src/main"), "quoted search");
        assertNull(policy.evaluate("Select-String -Path a.java -Pattern 'wslconfig'"), "quoted pattern");
        assertEquals(SecurityAction.DENY, policy.evaluate("wsl --status").action());
        assertEquals(SecurityAction.DENY, policy.evaluate("git status & wsl --status").action());
        assertEquals(SecurityAction.DENY, policy.evaluate("cmd /c wsl --status").action());
    }
    private ToolExecution call(String command) throws Exception {
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        when(workspace.bridge()).thenReturn(bridge);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().shellType(ShellType.CMD).build());
        return ToolExecution.builder().workspace(workspace).args(mapper.writeValueAsString(Map.of("command", command)))
                .toolDefinition(ToolDefinition.builder().name("command-test").id("command-test")
                        .executor(new CommandToolDefinitionExecutor(mapper, policy)).maxOutput(4096).timeout(10L).build()).build();
    }
}
