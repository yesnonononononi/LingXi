package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.conf.ModelConfig;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolExecution;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 缺陷B 的确定性回归守卫：为子执行解析 {@link WorkspaceSpec} 时，
 * sandbox 模式下「容器内 workDir 与 workspace.host_dir 不匹配」必须能回落到父会话绑定的工作空间，
 * 而不是抛 {@code IllegalStateException}。
 */
class SubAgentWorkspaceResolutionTest {

    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final WorkspaceConverter workspaceConverter = mock(WorkspaceConverter.class);

    private final SubAgentRequestFactory factory = new SubAgentRequestFactory(
            workspaceService, modelService, settingsProvider, workspaceConverter);

    @BeforeEach
    void stubModel() {
        when(settingsProvider.current()).thenReturn(Optional.empty());
        when(modelService.runtimeConfig(anyLong(), any())).thenReturn(ModelConfig.builder()
                .baseUrl("https://example.invalid").apiKey("k").modelName("m").build());
    }

    @Test
    void containerWorkDirFallsBackToParentWorkspaceSpec() {
        WorkspaceSpec spec = mock(WorkspaceSpec.class);
        WorkspaceVO parentVo = WorkspaceVO.builder().id(1L).name("t05-ws")
                .hostDir("D:\\Code\\LingXi\\.run\\t05_ws").workDir("/t05_ws").build();
        Workspace parent = mock(Workspace.class);

        // sandbox：模型回传的 workDir 是容器内路径，findByDir 必然落空
        when(workspaceService.findByDir("/t05_ws")).thenReturn(Result.success(null));
        when(workspaceService.findById(1L)).thenReturn(Result.success(parentVo));
        when(workspaceConverter.resolveType()).thenReturn(WorkspaceType.SAND_BOX);
        when(workspaceConverter.toSpec(any(WorkspaceVO.class), any(WorkspaceType.class))).thenReturn(spec);

        WorkspaceSpec resolved = buildWithWorkDir("/t05_ws", parent, 1L);

        assertSame(spec, resolved);
        verify(workspaceService).findByDir("/t05_ws");
        verify(workspaceService).findById(1L);
    }

    @Test
    void registeredWorkDirWinsWithoutParentFallback() {
        WorkspaceSpec spec = mock(WorkspaceSpec.class);
        WorkspaceVO matched = WorkspaceVO.builder().id(9L).name("local-ws")
                .hostDir("/host/dir").workDir("/host/dir").build();
        Workspace parent = mock(Workspace.class);

        when(workspaceService.findByDir("/host/dir")).thenReturn(Result.success(matched));
        when(workspaceConverter.resolveType()).thenReturn(WorkspaceType.LOCAL);
        when(workspaceConverter.toSpec(any(WorkspaceVO.class), any(WorkspaceType.class))).thenReturn(spec);

        WorkspaceSpec resolved = buildWithWorkDir("/host/dir", parent, 1L);

        assertSame(spec, resolved);
        verify(workspaceService).findByDir("/host/dir");
        verify(workspaceService, never()).findById(any());
    }

    @Test
    void noParentWorkspaceYieldsNullSpec() {
        when(workspaceService.findByDir(anyString())).thenReturn(Result.success(null));

        WorkspaceSpec resolved = buildWithWorkDir("/t05_ws", null, null);

        assertNull(resolved);
        verify(workspaceService, never()).findById(any());
    }

    /** 经 build 走完整链路，断言最终落到请求上的 workspaceSpec。 */
    private WorkspaceSpec buildWithWorkDir(String workDir, Workspace parentWorkspace, Long parentWorkspaceId) {
        AgentVO member = new AgentVO();
        member.setId(6L);
        member.setName("架构师");
        member.setModelId(4L);
        member.setToolList(List.of("read_file"));

        CallSubAgentToolArgument argument = new CallSubAgentToolArgument();
        argument.setAgentId(6L);
        argument.setTask("任务");
        argument.setWorkDir(workDir);

        ToolExecution toolExecution = ToolExecution.builder()
                .executionId("900")
                .workspace(parentWorkspace)
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5", ExecutionAttributes.TEAM_ID, "3"))
                .build();

        return factory.build(argument, member, TeamVO.builder().id(3L).commanderAgentId(5L)
                .agents(List.of(member)).build(), toolExecution, workDir, "1234", parentWorkspaceId, List.of())
                .getWorkspaceSpec();
    }
}
