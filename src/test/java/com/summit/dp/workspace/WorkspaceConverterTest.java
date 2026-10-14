package com.summit.dp.workspace;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.dp.workspace.domain.model.Workspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class WorkspaceConverterTest {
    @TempDir Path temporary;
    private final WorkspaceConverter converter = new WorkspaceConverter(mock(SettingsProvider.class),
            new SandboxPolicyFactory(List.of("api.example.test"), List.of("secrets"), List.of("readonly")));

    @Test
    void sandboxUsesHostDirectoryAndKeepsTheRequestedReadOnlyPolicy() throws Exception {
        WorkspaceVO view = WorkspaceVO.builder().id(1L).name("project")
                .hostDir(temporary.toString()).workDir("/old-container-directory").build();
        WorkspaceSpec spec = converter.toSpec(view, WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE);
        assertEquals("sandbox", spec.provider());
        assertEquals(temporary.toString(), spec.workDir());
        assertEquals(LocalInstance.ID, spec.scope());
        JsonNode policy = policy(spec);
        assertEquals(2, policy.path("denyWrite").size());
        assertEquals(temporary.toString(), policy.path("denyWrite").get(1).asText());
        assertEquals("readonly", policy.path("denyWrite").get(0).asText());
        assertEquals("secrets", policy.path("denyRead").get(0).asText());
        assertEquals("api.example.test", policy.path("allowedDomains").get(0).asText());
        assertEquals(spec, converter.toSpec(new Workspace(1L, "project", temporary.toString()),
                WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE));
        assertEquals(temporary.toString(), converter.resolveWorkDir(new Workspace(1L, "project", temporary.toString())));
    }

    @Test
    void sandboxFullAccessIsStillLimitedToWorkspaceWrites() throws Exception {
        WorkspaceSpec spec = converter.toSpec(new Workspace(1L, "project", temporary.toString()),
                WorkspaceType.SAND_BOX, AgentAccessMode.OUT_OF_WORKSPACE);
        assertTrue(policy(spec).path("allowWrite").isEmpty());
        assertEquals(List.of("readonly"), new ObjectMapper().convertValue(policy(spec).path("denyWrite"), List.class));
    }

    @Test
    void localModeKeepsItsExistingProviderAndNoSandboxPolicy() {
        WorkspaceSpec spec = converter.toSpec(new Workspace(1L, "project", temporary.toString()),
                WorkspaceType.LOCAL, AgentAccessMode.OUT_OF_WORKSPACE);
        assertEquals("local", spec.provider());
        assertEquals(temporary.toString(), spec.workDir());
        assertEquals(LocalInstance.ID, spec.scope());
        assertTrue(spec.configuration().isEmpty());
    }

    private JsonNode policy(WorkspaceSpec spec) throws Exception {
        return new ObjectMapper().readTree(spec.configuration().get("sandbox.policy"));
    }
}
