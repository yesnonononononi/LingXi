package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.application.decision.ApprovalWorkspaceResolver;
import com.summit.dp.workflow.application.decision.ApprovedFileWriteRestorer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 文件改动审批的重建：抬档只作用于本次调用，且过期快照一律拒绝。
 *
 * <p>「抬档」是口径 A 的核心：不抬档批准后照样被目录围栏拦住；抬档溢出到执行本身，
 * 则后续每一轮都变成完全访问 —— 两侧都必须有断言看着。</p>
 */
class ApprovedFileWriteRestorerTest {

    @TempDir
    Path workspaceRoot;

    private Workspace workspace;
    private ToolRegistry registry;
    private ApprovedFileWriteRestorer restorer;
    private ToolCallConverter converter;

    @BeforeEach
    void setUp() {
        workspace = workspaceAt(workspaceRoot);
        WorkspaceResolver resolver = mock(WorkspaceResolver.class);
        when(resolver.resolve(any(WorkspaceSpec.class))).thenReturn(workspace);
        registry = mock(ToolRegistry.class);
        converter = new ToolCallConverter(new ObjectMapper());
        restorer = new ApprovedFileWriteRestorer(new ObjectMapper(),
                new ApprovalWorkspaceResolver(resolver), provider(registry));
    }

    @Test
    @DisplayName("批准重建：本次调用带完全访问档，但执行自身的档位不变")
    void elevationIsScopedToTheSingleCall() {
        Execution execution = execution(AgentPermissionMode.APPROVAL_REQUIRED);
        stubTool(ToolCatalog.WRITE_FILE);

        ToolExecution call = restorer.restore(execution, card(ToolCatalog.WRITE_FILE, "../outside.txt", "../outside.txt"));

        assertEquals(AgentPermissionMode.FULL_ACCESS.name(),
                String.valueOf(call.getAttributes().get(AgentPermissionMode.ATTRIBUTE_KEY)),
                "批准后必须能真的写出去，否则卡片形同虚设");
        assertEquals(AgentPermissionMode.APPROVAL_REQUIRED.name(),
                String.valueOf(execution.getAgentRequest().runtimeParametersOrDefault().getAttributes()
                        .get(AgentPermissionMode.ATTRIBUTE_KEY)),
                "一次性授权不得写回执行本身，否则后续每轮都成了完全访问");
    }

    @Test
    @DisplayName("环境已变化：工作空间不一致即拒绝重放")
    void rejectsChangedWorkspace() {
        Execution execution = execution(AgentPermissionMode.APPROVAL_REQUIRED);
        stubTool(ToolCatalog.WRITE_FILE);
        ToolCall card = card(ToolCatalog.WRITE_FILE, "../outside.txt", "../outside.txt");
        ToolCall stale = ToolCall.builder().id(card.getId()).conversationId(2L).executionId(3L)
                .toolName(card.getToolName()).type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content(converter.fileWriteContent("../outside.txt", workspace.workDir(), "另一个工作空间",
                        argsWith("../outside.txt")))
                .rawInput("{\"args\":{}}").build();

        ClientException failure = assertThrows(ClientException.class, () -> restorer.restore(execution, stale));

        assertTrue(failure.getMessage().contains("环境已变化"));
    }

    @Test
    @DisplayName("参数不一致：卡片展示的路径与 args 里的路径对不上即拒绝")
    void rejectsInconsistentArguments() {
        Execution execution = execution(AgentPermissionMode.APPROVAL_REQUIRED);
        stubTool(ToolCatalog.WRITE_FILE);

        ClientException failure = assertThrows(ClientException.class,
                () -> restorer.restore(execution, card(ToolCatalog.WRITE_FILE, "../outside.txt", "../other.txt")));

        assertTrue(failure.getMessage().contains("参数不一致"));
    }

    @Test
    @DisplayName("已经落回工作区内：旧卡不能拿来放行")
    void rejectsPathThatIsNoLongerOutside() {
        Execution execution = execution(AgentPermissionMode.APPROVAL_REQUIRED);
        stubTool(ToolCatalog.WRITE_FILE);

        ClientException failure = assertThrows(ClientException.class,
                () -> restorer.restore(execution, card(ToolCatalog.WRITE_FILE, "notes.txt", "notes.txt")));

        assertTrue(failure.getMessage().contains("环境已变化"));
    }

    @Test
    @DisplayName("非写类工具：不开放抬档重放")
    void rejectsNonMutationTool() {
        Execution execution = execution(AgentPermissionMode.APPROVAL_REQUIRED);
        stubTool(ToolCatalog.READ_FILE);

        ClientException failure = assertThrows(ClientException.class,
                () -> restorer.restore(execution, card(ToolCatalog.READ_FILE, "../outside.txt", "../outside.txt")));

        assertTrue(failure.getMessage().contains("不是写类文件工具"));
    }

    private void stubTool(String toolName) {
        ToolDefinition<ToolExecutor> definition = ToolDefinition.builder()
                .id(toolName).name(toolName).timeout(1L).maxOutput(100)
                .executor(mock(ToolExecutor.class)).build();
        when(registry.<ToolExecutor>getTool(toolName)).thenReturn(definition);
    }

    private String argsWith(String path) {
        return "{\"type\":\"CREATE\",\"path\":\"" + path + "\",\"content\":\"x\"}";
    }

    private ToolCall card(String toolName, String contentPath, String argsPath) {
        return ToolCall.builder().id("call-1").conversationId(2L).executionId(3L)
                .toolName(toolName).type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content(converter.fileWriteContent(contentPath, workspace.workDir(), workspace.id(),
                        argsWith(argsPath)))
                .rawInput("{\"args\":{}}").build();
    }

    private Execution execution(AgentPermissionMode mode) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(AgentPermissionMode.ATTRIBUTE_KEY, mode.name());
        AgentRequest request = AgentRequest.builder()
                .workspaceSpec(mock(WorkspaceSpec.class))
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                .build();
        return Execution.builder().id("3").lastResponseId("9007199254740993")
                .executionState(ExecutionState.SUSPENDED)
                .agentRequest(request).messages(new ArrayList<>()).build();
    }

    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }

    private static Workspace workspaceAt(Path root) {
        return new Workspace() {
            @Override
            public String id() {
                return "ws-test";
            }

            @Override
            public RuntimeEnvironment runtimeEnvironment() {
                return null;
            }

            @Override
            public String workDir() {
                return root.toAbsolutePath().normalize().toString();
            }

            @Override
            public Path resolve(String path) {
                return root.resolve(path).normalize();
            }
        };
    }
}
