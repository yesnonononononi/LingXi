package com.summit.dp.workspace;

import com.summit.core.workspace.WorkspaceSpec;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.exception.ClientException;
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
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class WorkspaceConverterTest {
    @TempDir Path temporary;
    private WorkspaceConverter converter(List<String> writes) {
        return new WorkspaceConverter(mock(SettingsProvider.class), new SandboxPolicyFactory(List.of("/tools"), writes, Map.of("LANG", "C.UTF-8")));
    }
    @Test void modesCreateIndependentPoliciesAndKeepReadOnlyAtTheSandboxBoundary() {
        Workspace project = new Workspace(1L, "project", temporary.toString());
        WorkspaceConverter converter = converter(List.of("/cache"));
        MxcWorkspaceSpec writable = (MxcWorkspaceSpec) converter.toSpec(project, WorkspaceType.SAND_BOX, AgentAccessMode.IN_WORKSPACE);
        MxcWorkspaceSpec readonly = (MxcWorkspaceSpec) converter.toSpec(project, WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE);
        MxcWorkspaceSpec outside = (MxcWorkspaceSpec) converter.toSpec(project, WorkspaceType.SAND_BOX, AgentAccessMode.OUT_OF_WORKSPACE);
        assertEquals("mxc", writable.provider());
        assertEquals(LocalInstance.ID, writable.scope());
        assertTrue(writable.writable());
        assertFalse(readonly.writable());
        assertTrue(readonly.readwritePaths().isEmpty());
        assertTrue(writable.readwritePaths().isEmpty());
        assertEquals(List.of("/tools", "/cache"), writable.readonlyPaths());
        assertEquals(List.of("/cache"), outside.readwritePaths());
        assertEquals(List.of("/tools"), outside.readonlyPaths());
        assertTrue(writable.readwritePaths().isEmpty());
    }
    @Test void outsideWritesRequireAnExplicitDeploymentGrant() {
        assertThrows(ClientException.class, () -> converter(List.of()).toSpec(new Workspace(1L,"project",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentAccessMode.OUT_OF_WORKSPACE));
    }
    @Test void localAndSandboxModesUseNativeHostPaths() {
        WorkspaceSpec local = converter(List.of()).toSpec(new Workspace(1L,"project",temporary.toString()), WorkspaceType.LOCAL, AgentAccessMode.OUT_OF_WORKSPACE);
        assertEquals("local", local.provider());
        assertEquals(temporary.toString(), local.workDir());
        assertEquals(temporary.toString(), converter(List.of()).toSpec(new Workspace(2L,"native",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentAccessMode.IN_WORKSPACE).workDir());
    }
    @Test void businessSnapshotMapperRestoresMxcPolicyAndItsReadOnlyFlag() throws Exception {
        ObjectMapper mapper = new JsonConfig().objectMapper();
        WorkspaceSpec spec = converter(List.of()).toSpec(new Workspace(1L,"project",temporary.toString()),
                WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE);
        String json = mapper.writerFor(WorkspaceSpec.class).writeValueAsString(spec);
        assertEquals(spec, mapper.readValue(json, WorkspaceSpec.class));
    }
}
