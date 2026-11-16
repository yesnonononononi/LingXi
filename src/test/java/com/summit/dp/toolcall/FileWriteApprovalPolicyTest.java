package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.application.decision.FileWriteApprovalRegistrar;
import com.summit.dp.workflow.infrastructure.policy.FileWriteApprovalPolicy;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * 越界写入审批策略：什么时候弹卡、什么时候直通。
 *
 * <p>这些判据任何一条反了都会产生真实后果：多弹卡=每次正常写文件都要点批准，
 * 少弹卡=越界改动静默落盘。</p>
 */
class FileWriteApprovalPolicyTest {

    @TempDir
    Path workspaceRoot;

    private FileWriteApprovalRegistrar registrar;
    private FileWriteApprovalPolicy policy;

    @BeforeEach
    void setUp() {
        registrar = mock(FileWriteApprovalRegistrar.class);
        policy = new FileWriteApprovalPolicy(new ObjectMapper(), registrar);
    }

    @ParameterizedTest
    @ValueSource(strings = {ToolCatalog.WRITE_FILE, ToolCatalog.EDIT_FILE, ToolCatalog.DELETE_FILE})
    @DisplayName("写类工具越界：登记卡片并挂起等待批准")
    void outsideMutationRequestsApproval(String toolName) {
        ToolExecuteResult result = policy.beforeExecution(call(toolName, outsideArgs(), AgentPermissionMode.APPROVAL_REQUIRED));

        assertTrue(result.isPromise(), "越界写必须挂起等批准，而不是直接执行或直接报错");
        verify(registrar).register(any(), anyString());
    }

    @Test
    @DisplayName("工作区内的写入：直通，不打扰用户")
    void insideMutationGoesStraightThrough() {
        ToolExecuteResult result = policy.beforeExecution(call(ToolCatalog.WRITE_FILE,
                "{\"type\":\"CREATE\",\"path\":\"notes.txt\",\"content\":\"x\"}", AgentPermissionMode.APPROVAL_REQUIRED));

        assertNull(result, "工作区内写入不该产生审批卡");
        verify(registrar, never()).register(any(), anyString());
    }

    @Test
    @DisplayName("完全访问档：越界写入是用户的明确授权，不再逐次批准")
    void fullAccessModeSkipsApproval() {
        ToolExecuteResult result = policy.beforeExecution(call(ToolCatalog.WRITE_FILE, outsideArgs(),
                AgentPermissionMode.FULL_ACCESS));

        assertNull(result, "完全访问档不应再弹卡");
        verify(registrar, never()).register(any(), anyString());
    }

    @Test
    @DisplayName("非写类工具：策略完全不参与")
    void nonMutationToolIsIgnored() {
        ToolExecuteResult result = policy.beforeExecution(call(ToolCatalog.READ_FILE, outsideArgs(),
                AgentPermissionMode.APPROVAL_REQUIRED));

        assertNull(result, "读文件不在本策略范围内");
        verify(registrar, never()).register(any(), anyString());
    }

    @Test
    @DisplayName("参数里没有 path：交给执行器按自己的参数校验报错，策略不猜")
    void missingPathIsLeftToExecutor() {
        ToolExecuteResult result = policy.beforeExecution(call(ToolCatalog.WRITE_FILE,
                "{\"content\":\"x\"}", AgentPermissionMode.APPROVAL_REQUIRED));

        assertNull(result);
        verify(registrar, never()).register(any(), anyString());
    }

    @Test
    @DisplayName("工作空间不可用时不伪造卡片：直接报错")
    void unavailableWorkspaceFailsLoudly() {
        ToolExecution execution = call(ToolCatalog.WRITE_FILE, outsideArgs(), AgentPermissionMode.APPROVAL_REQUIRED);
        ToolExecution withoutWorkspace = ToolExecution.builder()
                .id(execution.getId()).executionId(execution.getExecutionId())
                .toolDefinition(execution.getToolDefinition()).args(execution.getArgs())
                .attributes(execution.getAttributes()).build();

        ToolExecuteResult result = policy.beforeExecution(withoutWorkspace);

        assertTrue(result.getToolOutput().contains("无法发起审批"));
        verify(registrar, never()).register(any(), anyString());
    }

    @Test
    @DisplayName("边界判定与执行器同源：工作空间根目录下的路径算工作区内")
    void boundaryMatchesExecutor() {
        Workspace workspace = workspaceAt(workspaceRoot);

        assertTrue(workspace.encloses(workspace.resolve("a/b.txt")), "根目录内路径必须判定为工作区内");
        assertFalse(workspace.encloses(workspace.resolve("../b.txt")), "父目录路径必须判定为越界");
    }

    private String outsideArgs() {
        // 目标在工作空间父目录：名字固定，便于断言
        return "{\"type\":\"CREATE\",\"path\":\"../outside.txt\",\"content\":\"x\"}";
    }

    private ToolExecution call(String toolName, String args, AgentPermissionMode mode) {
        ToolDefinition<ToolExecutor> definition = ToolDefinition.builder()
                .id(toolName).name(toolName).timeout(1L).maxOutput(100)
                .executor(mock(ToolExecutor.class)).build();
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(AgentPermissionMode.ATTRIBUTE_KEY, mode.name());
        return ToolExecution.builder()
                .id("call-1")
                .executionId("3")
                .toolDefinition(definition)
                .args(args)
                .workspace(workspaceAt(workspaceRoot))
                .attributes(attributes)
                .build();
    }

    /** 真实边界判定要跑框架默认的 {@code resolveInside}，因此这里用真实现而不是 mock。 */
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
