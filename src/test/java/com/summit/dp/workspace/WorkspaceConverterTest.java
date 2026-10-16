package com.summit.dp.workspace;

import com.summit.core.workspace.WorkspaceSpec;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
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
        MxcWorkspaceSpec writable = (MxcWorkspaceSpec) converter.toSpec(project, WorkspaceType.SAND_BOX, AgentAccessMode.IN_WORKSPACE);
        MxcWorkspaceSpec readonly = (MxcWorkspaceSpec) converter.toSpec(project, WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE);
        assertEquals("sandbox", writable.provider());
        assertEquals(LocalInstance.ID, writable.scope());
        assertTrue(writable.writable());
        assertFalse(readonly.writable());
        assertTrue(readonly.readwritePaths().isEmpty());
        assertTrue(writable.readwritePaths().isEmpty());
        assertFalse(writable.readonlyPaths().contains(temporary.toString()));
        assertEquals(writable.readonlyPaths(), readonly.readonlyPaths());
        assertEquals(temporary.toString(), readonly.workDir());
        assertEquals(writable.environment(), readonly.environment());
    }
    @Test void projectOutsideModeStillKeepsPrivacyDenials() {
        MxcWorkspaceSpec spec = (MxcWorkspaceSpec) converter().toSpec(new Workspace(1L,"project",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentAccessMode.OUT_OF_WORKSPACE);
        assertTrue(spec.writable());
        assertFalse(spec.securityPolicy().deniedPaths().isEmpty());
    }
    @Test void localAndSandboxModesUseNativeHostPaths() {
        WorkspaceSpec local = converter().toSpec(new Workspace(1L,"project",temporary.toString()), WorkspaceType.LOCAL, AgentAccessMode.OUT_OF_WORKSPACE);
        assertEquals("local", local.provider());
        assertEquals(temporary.toString(), local.workDir());
        assertEquals(temporary.toString(), converter().toSpec(new Workspace(2L,"native",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentAccessMode.IN_WORKSPACE).workDir());
    }
    @Test void businessSnapshotMapperRestoresMxcPolicyAndItsReadOnlyFlag() throws Exception {
        ObjectMapper mapper = new JsonConfig().objectMapper();
        WorkspaceSpec spec = converter().toSpec(new Workspace(1L,"project",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE);
        String json = mapper.writerFor(WorkspaceSpec.class).writeValueAsString(spec);
        assertEquals(spec, mapper.readValue(json, WorkspaceSpec.class));
    }

    @Test void projectPathIsNormalizedWhileNativePrivacyPolicyIsRetained() {
        Path project = temporary.resolve("项目 workspace");
        Workspace workspace = new Workspace(1L, "project", project.resolve("nested/..").toString());
        MxcWorkspaceSpec spec = (MxcWorkspaceSpec) converter().toSpec(workspace, WorkspaceType.SAND_BOX, null);
        assertEquals(project.toString(), spec.workDir());
        assertTrue(spec.writable());
        assertFalse(spec.securityPolicy().deniedPaths().isEmpty());
        assertTrue(spec.readwritePaths().isEmpty());
    }
}
