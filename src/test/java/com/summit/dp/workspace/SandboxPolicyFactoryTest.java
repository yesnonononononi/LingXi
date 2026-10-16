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
            assertTrue(spec.securityPolicy().deniedPaths().stream().anyMatch(path -> path.endsWith("/.ssh")), "隐私预设必须进入原生拒绝策略");
            assertTrue(spec.securityPolicy().allowOutboundNetwork());
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

    @Test void writableModesBothKeepNativePrivacyDenials() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        MxcWorkspaceSpec ordinary = factory.build(temporary.toString(), AgentAccessMode.IN_WORKSPACE);
        MxcWorkspaceSpec full = factory.build(temporary.toString(), AgentAccessMode.OUT_OF_WORKSPACE);
        assertEquals(ordinary.securityPolicy(), full.securityPolicy());
        assertFalse(full.securityPolicy().deniedPaths().isEmpty());
        assertTrue(full.writable());
    }
}
