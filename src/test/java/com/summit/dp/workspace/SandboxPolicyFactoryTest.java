package com.summit.dp.workspace;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class SandboxPolicyFactoryTest {
    @TempDir Path temporary;

    @Test void rootPermissionsUseTheRequestedModeWithoutConflictingExtraGrants() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        String project = temporary.resolve("project").toString();
        for (AgentAccessMode mode : new AgentAccessMode[]{AgentAccessMode.IN_WORKSPACE, AgentAccessMode.READ_ONLY_IN_WORKSPACE}) {
            MxcWorkspaceSpec spec = factory.build(project, mode);
            assertEquals(project, spec.workDir());
            assertEquals(LocalInstance.ID, spec.scope());
            assertEquals(mode == AgentAccessMode.IN_WORKSPACE, spec.writable());
            assertTrue(spec.readonlyPaths().isEmpty(), "项目根目录由 writable 标志授权，不能再叠加只读授权");
            assertTrue(spec.readwritePaths().isEmpty(), "沙箱不开放额外项目外目录");
        }
    }

    @Test void missingModeUsesTheWritableWorkspaceDefault() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        String project = temporary.toString();
        assertEquals(factory.build(project, AgentAccessMode.IN_WORKSPACE), factory.build(project, null));
        assertTrue(factory.build(project, null).writable());
    }

    @Test void reusingTheFactoryDoesNotLeakPreviousProjectPathsOrPermissions() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        String first = temporary.resolve("first project").toString();
        String second = temporary.resolve("second project").toString();
        MxcWorkspaceSpec writable = factory.build(first, AgentAccessMode.IN_WORKSPACE);
        MxcWorkspaceSpec readonly = factory.build(second, AgentAccessMode.READ_ONLY_IN_WORKSPACE);
        assertEquals(first, writable.workDir());
        assertEquals(second, readonly.workDir());
        assertTrue(writable.writable());
        assertFalse(readonly.writable());
        assertEquals(writable, factory.build(first, AgentAccessMode.IN_WORKSPACE));
    }

    @Test void callerEnvironmentCannotChangeAnAlreadyCreatedPolicy() {
        Map<String, String> environment = new HashMap<>(Map.of("LANG", "C.UTF-8"));
        SandboxPolicyFactory factory = new SandboxPolicyFactory(environment);
        environment.put("NODE_OPTIONS", "--require=unexpected-preload.js");
        MxcWorkspaceSpec spec = factory.build(temporary.toString(), AgentAccessMode.IN_WORKSPACE);
        assertEquals(Map.of("LANG", "C.UTF-8"), spec.environment());
        assertThrows(UnsupportedOperationException.class, () -> spec.environment().put("LANG", "changed"));
    }

    @Test void fullAccessIsRejectedBeforeAnySandboxPolicyCanBeReturned() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        ClientException failure = assertThrows(ClientException.class,
                () -> factory.build(temporary.toString(), AgentAccessMode.OUT_OF_WORKSPACE));
        assertEquals("当前沙箱不支持完全访问，请使用本地模式", failure.getMessage());
    }
}
