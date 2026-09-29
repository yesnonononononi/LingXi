package com.summit.dp.tools.baseTools.sub_agent;

import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.mockito.ArgumentMatchers.any;
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
class CallSubAgentToolWorkspaceTest {

    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final WorkspaceConverter workspaceConverter = mock(WorkspaceConverter.class);

    /** resolveWorkspaceSpec 只依赖 workspaceService + workspaceConverter，其余构造参数可空。 */
    private final CallSubAgentTool tool = new CallSubAgentTool(
            null, workspaceService, null, null, null, null, workspaceConverter,
            null, null, null, null, null, null);

    private WorkspaceSpec resolve(String workDir, Workspace parentWorkspace, Long parentWorkspaceId) {
        return ReflectionTestUtils.invokeMethod(tool, "resolveWorkspaceSpec",
                workDir, parentWorkspace, parentWorkspaceId);
    }

    @Test
    void containerWorkDirFallsBackToParentWorkspaceSpec() {
        WorkspaceSpec spec = mock(WorkspaceSpec.class);
        WorkspaceVO parentVo = WorkspaceVO.builder().id(1L).name("t05-ws").hostDir("D:\\Code\\LingXi\\.run\\t05_ws").workDir("/t05_ws").build();
        Workspace parent = mock(Workspace.class);

        // sandbox：模型回传的 workDir 是容器内路径，findByDir 必然落空
        when(workspaceService.findByDir("/t05_ws")).thenReturn(Result.success(null));
        when(workspaceService.findById(1L)).thenReturn(Result.success(parentVo));
        when(workspaceConverter.resolveType()).thenReturn(WorkspaceType.SAND_BOX);
        when(workspaceConverter.toSpec(any(WorkspaceVO.class), any(WorkspaceType.class))).thenReturn(spec);

        WorkspaceSpec resolved = resolve("/t05_ws", parent, 1L);

        assertSame(spec, resolved);
        verify(workspaceService).findByDir("/t05_ws");
        verify(workspaceService).findById(1L);
    }

    @Test
    void registeredWorkDirWinsWithoutParentFallback() {
        WorkspaceSpec spec = mock(WorkspaceSpec.class);
        WorkspaceVO matched = WorkspaceVO.builder().id(9L).name("local-ws").hostDir("/host/dir").workDir("/host/dir").build();
        Workspace parent = mock(Workspace.class);

        when(workspaceService.findByDir("/host/dir")).thenReturn(Result.success(matched));
        when(workspaceConverter.resolveType()).thenReturn(WorkspaceType.LOCAL);
        when(workspaceConverter.toSpec(any(WorkspaceVO.class), any(WorkspaceType.class))).thenReturn(spec);

        WorkspaceSpec resolved = resolve("/host/dir", parent, 1L);

        assertSame(spec, resolved);
        verify(workspaceService).findByDir("/host/dir");
        verify(workspaceService, never()).findById(any());
    }

    @Test
    void noParentWorkspaceYieldsNullSpec() {
        when(workspaceService.findByDir(anyString())).thenReturn(Result.success(null));

        WorkspaceSpec resolved = resolve("/t05_ws", null, null);

        assertNull(resolved);
        verify(workspaceService, never()).findById(any());
    }
}
