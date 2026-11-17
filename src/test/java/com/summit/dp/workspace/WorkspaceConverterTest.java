package com.summit.dp.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.sandbox.windows.WindowsWorkspaceProvider;
import com.summit.sandbox.windows.WindowsWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class WorkspaceConverterTest {
    @TempDir Path temporary;
    private WorkspaceConverter converter() {
        return new WorkspaceConverter(mock(SettingsProvider.class), new SandboxPolicyFactory(Map.of("LANG", "C.UTF-8")));
    }
    @Test void modesCreateIndependentPoliciesAndKeepReadOnlyAtTheSandboxBoundary() {
        Workspace project = new Workspace(1L, "project", temporary.toString());
        WorkspaceConverter converter = converter();
        WindowsWorkspaceSpec writable = (WindowsWorkspaceSpec) converter.toSpec(project, WorkspaceType.SAND_BOX, AgentPermissionMode.APPROVAL_REQUIRED);
        WindowsWorkspaceSpec readonly = (WindowsWorkspaceSpec) converter.toSpec(project, WorkspaceType.SAND_BOX, AgentPermissionMode.READ_ONLY_REVIEW);
        assertEquals(WindowsWorkspaceProvider.TYPE, writable.provider());
        assertEquals(LocalInstance.ID, writable.scope());
        assertEquals(temporary.toString(), readonly.workDir());
        assertEquals(writable.environment(), readonly.environment());
    }
    @Test void projectOutsideModeBuildsSandboxSpec() {
        WindowsWorkspaceSpec spec = (WindowsWorkspaceSpec) converter().toSpec(new Workspace(1L,"project",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentPermissionMode.FULL_ACCESS);
        assertEquals(temporary.toString(), spec.workDir());
    }
    @Test void localAndSandboxModesUseNativeHostPaths() {
        WorkspaceSpec local = converter().toSpec(new Workspace(1L,"project",temporary.toString()), WorkspaceType.LOCAL, AgentPermissionMode.FULL_ACCESS);
        assertEquals("local", local.provider());
        assertEquals(temporary.toString(), local.workDir());
        assertEquals(temporary.toString(), converter().toSpec(new Workspace(2L,"native",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentPermissionMode.APPROVAL_REQUIRED).workDir());
    }
    @Test void businessSnapshotMapperRestoresWindowsSandboxPolicyAndItsReadOnlyFlag() throws Exception {
        ObjectMapper mapper = new JsonConfig().objectMapper();
        WorkspaceSpec spec = converter().toSpec(new Workspace(1L,"project",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentPermissionMode.READ_ONLY_REVIEW);
        String json = mapper.writerFor(WorkspaceSpec.class).writeValueAsString(spec);
        assertEquals(spec, mapper.readValue(json, WorkspaceSpec.class));
    }

    @Test void projectPathIsNormalized() {
        Path project = temporary.resolve("项目 workspace");
        Workspace workspace = new Workspace(1L, "project", project.resolve("nested/..").toString());
        WindowsWorkspaceSpec spec = (WindowsWorkspaceSpec) converter().toSpec(workspace, WorkspaceType.SAND_BOX, null);
        assertEquals(project.toString(), spec.workDir());
    }
}
