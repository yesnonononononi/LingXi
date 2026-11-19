package com.summit.dp.workflow.application.chat;

import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.ModelConfig;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.sandbox.windows.WindowsWorkspaceSpec;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 重发必须复现目标轮次「当时看到的」系统提示词与记忆段。
 *
 * <p>这两个字段逐字进前缀缓存。若重发时按「现在」重建，旧历史里的动态上下文块与新的记忆段
 * 对不上，框架判定动态段被改写，缓存从该点整段作废 —— 用户看到的是「重发一下，上下文全价重算」。
 * 断言必须能因这条缺陷变红：拆掉复用逻辑，第一条用例立刻失败。</p>
 *
 * <p>本类只守「快照 → AgentRequest 逐字无损」；快照由 {@code ResendTargetResolver} 从检查点取出，
 * 那一侧的逐字性由 {@code ResendConfigurationReferenceTest} 守。</p>
 */
class RequestPreparerResendTest {

    private static final long SESSION_ID = 600L;
    private static final String EXECUTION_ID = "2106000000000000002";

    private final McpService mcpService = mock(McpService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);

    @Test
    @DisplayName("重发照搬快照里的系统提示词与记忆段，且不再去现读记忆")
    void resendReusesTheSnapshotSystemPromptAndMemory(@TempDir Path project) {
        when(mcpService.currentConfig()).thenReturn(null);
        AtomicInteger memoryLoads = new AtomicInteger();
        RequestPreparer preparer = RequestPreparerTestSupport.builder()
                .mcpService(mcpService)
                .sessionRepository(sessionRepository)
                .memoryLoaders(List.of(workspace -> {
                    memoryLoads.incrementAndGet();
                    return List.of("现在才有的记忆段");
                }))
                .build();
        ResendSnapshot snapshot = new ResendSnapshot("当时的系统提示词", List.of("当时的记忆段"));

        AgentRequest request = preparer.buildRequest("当时的人设",
                context(project).withResendSnapshot(snapshot), List.of());

        assertEquals("当时的系统提示词", request.getContextSpec().getSystemPrompt());
        assertEquals(List.of("当时的记忆段"), request.getContextSpec().getMemory());
        assertEquals(0, memoryLoads.get(), "重发还去现读记忆，记忆段就会随项目内容变，缓存照样作废");
    }

    @Test
    @DisplayName("普通请求不受影响：没有快照时仍按当轮工作区重建记忆")
    void plainRequestsStillRebuildFromTheCurrentWorkspace(@TempDir Path project) throws IOException {
        when(mcpService.currentConfig()).thenReturn(null);
        Files.writeString(project.resolve("AGENTS.md"), "现在的新公约\n", StandardCharsets.UTF_8);
        RequestPreparer preparer = RequestPreparerTestSupport.builder()
                .mcpService(mcpService)
                .sessionRepository(sessionRepository)
                .memoryLoaders(List.of(workspace -> List.of("现在才有的记忆段")))
                .build();

        AgentRequest request = preparer.buildRequest("prompt", context(project), List.of());

        assertEquals(List.of("现在才有的记忆段"), request.getContextSpec().getMemory());
    }

    private RuntimeContext context(Path project) {
        WorkspaceSpec workspace = new WindowsWorkspaceSpec(project.toString());
        ExecutionContext executionContext = ExecutionContext.root(SESSION_ID, EXECUTION_ID, null, null,
                AgentPermissionMode.FULL_ACCESS);
        return RuntimeContextTestSupport.beforeAdmission(executionContext, null, null, SessionVO.builder().id(SESSION_ID).build(),
                List.of(), workspace,
                ModelConfig.builder().baseUrl("https://example.invalid").apiKey("k").modelName("m").build(),
                AgentPermissionMode.FULL_ACCESS, false, null, false);
    }
}
