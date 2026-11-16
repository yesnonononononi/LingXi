package com.summit.dp.workflow.infrastructure.policy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.sandbox_security.application.FileRuleMatcher;
import com.summit.dp.sandbox_security.application.FileRuleMatcher.Operation;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.tools.application.port.ToolCatalog;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class FileSecurityPolicyTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final FileRuleMatcher matcher = mock(FileRuleMatcher.class);
    private final FileSecurityPolicy policy = new FileSecurityPolicy(mapper, matcher);
    private final Path protectedDir = Path.of(System.getProperty("user.home"), ".ssh").toAbsolutePath().normalize();

    private ToolExecution call(String toolName, String path) throws Exception {
        Workspace workspace = mock(Workspace.class);
        when(workspace.resolve(anyString())).thenAnswer(call -> Path.of(call.getArgument(0, String.class)));
        return ToolExecution.builder()
                .workspace(workspace)
                .args(mapper.writeValueAsString(Map.of("path", path)))
                .toolDefinition(ToolDefinition.builder().name(toolName).id(toolName)
                        .executor(mock(ToolExecutor.class)).maxOutput(100).timeout(5L).build())
                .build();
    }

    private void denyEverything() {
        when(matcher.evaluate(any(), any(), any()))
                .thenReturn(new SecurityDecision(SecurityAction.DENY, protectedDir.toString(), "PATH", null));
    }

    @Test
    void deniedPathStopsTheCallWithAnExplanationNamingThePath() throws Exception {
        denyEverything();
        ToolExecuteResult result = policy.beforeExecution(
                call(ToolCatalog.READ_FILE, protectedDir.resolve("id_rsa").toString()));
        assertNotNull(result, "命中拒绝规则时必须返回拒绝结果，而不是放行");
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("文件访问被安全规则禁止"), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("id_rsa"), result.getToolOutput());
    }

    @Test
    void everyPathToolIsMappedToItsOwnOperation() throws Exception {
        when(matcher.evaluate(any(), any(), any())).thenReturn(null);
        String target = protectedDir.resolve("key").toString();

        policy.beforeExecution(call(ToolCatalog.READ_FILE, target));
        policy.beforeExecution(call(ToolCatalog.SEARCH_FILES, target));
        policy.beforeExecution(call(ToolCatalog.READ_IMAGE, target));
        policy.beforeExecution(call(ToolCatalog.WRITE_FILE, target));
        policy.beforeExecution(call(ToolCatalog.EDIT_FILE, target));
        policy.beforeExecution(call(ToolCatalog.DELETE_FILE, target));

        Path resolved = Path.of(target).toAbsolutePath().normalize();
        verify(matcher, times(3)).evaluate(eq(resolved), eq(Operation.READ), any());
        verify(matcher, times(2)).evaluate(eq(resolved), eq(Operation.WRITE), any());
        verify(matcher, times(1)).evaluate(eq(resolved), eq(Operation.DELETE), any());
        verifyNoMoreInteractions(matcher);
    }

    @Test
    void nonFileToolsAndMissingArgumentsAreNotJudged() throws Exception {
        denyEverything();
        assertNull(policy.beforeExecution(call(ToolCatalog.EXECUTE_COMMAND, protectedDir.toString())));
        assertNull(policy.beforeExecution(call(ToolCatalog.CREATE_CHECKLIST, protectedDir.toString())));
        verifyNoInteractions(matcher);
    }

    @Test
    void unparsableArgumentsFallThroughToTheExecutor() throws Exception {
        ToolExecution broken = ToolExecution.builder()
                .workspace(mock(Workspace.class))
                .args("{\"path\": ")
                .toolDefinition(ToolDefinition.builder().name(ToolCatalog.READ_FILE).id(ToolCatalog.READ_FILE)
                        .executor(mock(ToolExecutor.class)).maxOutput(100).timeout(5L).build())
                .build();
        assertNull(policy.beforeExecution(broken));
        verifyNoInteractions(matcher);
    }

    @Test
    void runsBeforeTheOutOfWorkspaceApprovalCard() {
        // 先裁决再弹卡：被规则禁止的路径不该先给用户一张「点批准就能写」的卡。
        assertTrue(policy.order() < new FileWriteApprovalPolicy(null, null).order(),
                "文件规则必须早于越界写入审批");
    }
}
