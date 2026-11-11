package com.summit.dp.workflow.application.chat;

import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.ModelConfig;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.workflow.infrastructure.memory.AgentsMdLoader;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 「记忆正文要真正进 ContextSpec.memory」的装配契约。
 *
 * <p>框架只渲染 {@code ContextSpec.memory}，业务侧漏掉那一行 {@code .memory(...)}
 * 编译照样通过、请求照样成功，只是模型再也看不到项目公约 —— 没人会报错，
 * 所以只能靠这条用例守。</p>
 */
class RequestPreparerMemoryTest {

    private static final long SESSION_ID = 500L;
    private static final String EXECUTION_ID = "2105000000000000001";

    private final McpService mcpService = mock(McpService.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);

    @Test
    @DisplayName("多个 MemoryLoader 的正文按注册顺序进入 ContextSpec.memory")
    void loaderBodiesLandInContextSpecMemory(@TempDir Path project) {
        when(mcpService.currentConfig()).thenReturn(null);
        WorkspaceSpec workspace = new MxcWorkspaceSpec(project.toString());
        AtomicReference<WorkspaceSpec> seen = new AtomicReference<>();
        RequestPreparer preparer = RequestPreparerTestSupport.builder()
                .mcpService(mcpService)
                .sessionRepository(sessionRepository)
                .memoryLoaders(List.of(
                        spec -> {
                            seen.set(spec);
                            return List.of("第一段");
                        },
                        spec -> List.of("第二段")))
                .build();

        AgentRequest request = preparer.buildRequest("prompt", context(workspace), List.of());

        assertEquals(List.of("第一段", "第二段"), request.getContextSpec().getMemory());
        assertEquals(workspace, seen.get(), "记忆来源必须拿到本轮工作区，否则读不到项目文件");
    }

    @Test
    @DisplayName("AgentsMdLoader 读到的项目公约经 RequestPreparer 落到 ContextSpec.memory")
    void agentsMdReachesContextSpecMemory(@TempDir Path project) throws IOException {
        when(mcpService.currentConfig()).thenReturn(null);
        Files.writeString(project.resolve("AGENTS.md"), "禁止打补丁式开发\n", StandardCharsets.UTF_8);
        RequestPreparer preparer = RequestPreparerTestSupport.builder()
                .mcpService(mcpService)
                .sessionRepository(sessionRepository)
                .memoryLoaders(List.of(new AgentsMdLoader()))
                .build();

        AgentRequest request = preparer.buildRequest("prompt", context(new MxcWorkspaceSpec(project.toString())), List.of());

        List<String> memory = new ArrayList<>(request.getContextSpec().getMemory());
        assertEquals(1, memory.size());
        assertTrue(memory.get(0).contains("禁止打补丁式开发"), memory.get(0));
    }

    @Test
    @DisplayName("未绑定工作区时不产生记忆段")
    void noWorkspaceMeansNoMemory() {
        when(mcpService.currentConfig()).thenReturn(null);
        RequestPreparer preparer = RequestPreparerTestSupport.builder()
                .mcpService(mcpService)
                .sessionRepository(sessionRepository)
                .memoryLoaders(List.of(new AgentsMdLoader()))
                .build();

        AgentRequest request = preparer.buildRequest("prompt", context(null), List.of());

        assertEquals(List.of(), request.getContextSpec().getMemory());
    }

    private RuntimeContext context(WorkspaceSpec workspace) {
        ExecutionContext executionContext = ExecutionContext.root(SESSION_ID, EXECUTION_ID, null, null,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null, SessionVO.builder().id(SESSION_ID).build(),
                List.of(), workspace,
                ModelConfig.builder().baseUrl("https://example.invalid").apiKey("k").modelName("m").build(),
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS, false, null, false);
    }
}