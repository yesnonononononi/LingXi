package com.summit.dp.workspace;

import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.sandbox.windows.WindowsWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class SandboxPolicyFactoryTest {
    @TempDir Path temporary;

    @Test void rootPermissionsUseTheRequestedMode() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        String project = temporary.resolve("project").toString();
        for (AgentPermissionMode mode : new AgentPermissionMode[]{AgentPermissionMode.APPROVAL_REQUIRED, AgentPermissionMode.READ_ONLY_REVIEW}) {
            WindowsWorkspaceSpec spec = factory.build(project, mode);
            assertEquals(project, spec.workDir());
            assertEquals(LocalInstance.ID, spec.scope());
            assertEquals(mode.isWorkspaceWritable(), spec.writable());
        }
    }

    @Test void missingModeUsesTheWritableWorkspaceDefault() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        String project = temporary.toString();
        assertEquals(factory.build(project, AgentPermissionMode.DEFAULT), factory.build(project, null));
        assertTrue(factory.build(project, null).writable());
    }

    @Test void reusingTheFactoryDoesNotLeakPreviousProjectPathsOrPermissions() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        String first = temporary.resolve("first project").toString();
        String second = temporary.resolve("second project").toString();
        WindowsWorkspaceSpec writable = factory.build(first, AgentPermissionMode.APPROVAL_REQUIRED);
        WindowsWorkspaceSpec readonly = factory.build(second, AgentPermissionMode.READ_ONLY_REVIEW);
        assertEquals(first, writable.workDir());
        assertEquals(second, readonly.workDir());
        assertTrue(writable.writable());
        assertFalse(readonly.writable());
        assertEquals(writable, factory.build(first, AgentPermissionMode.APPROVAL_REQUIRED));
    }

    @Test void callerEnvironmentCannotChangeAnAlreadyCreatedPolicy() {
        Map<String, String> environment = new HashMap<>(Map.of("LANG", "C.UTF-8"));
        SandboxPolicyFactory factory = new SandboxPolicyFactory(environment);
        environment.put("NODE_OPTIONS", "--require=unexpected-preload.js");
        WindowsWorkspaceSpec spec = factory.build(temporary.toString(), AgentPermissionMode.APPROVAL_REQUIRED);
        assertEquals(Map.of("LANG", "C.UTF-8"), spec.environment());
        assertThrows(UnsupportedOperationException.class, () -> spec.environment().put("LANG", "changed"));
    }

    @Test void outOfWorkspaceModeAllowsWriteTools() {
        SandboxPolicyFactory factory = new SandboxPolicyFactory(Map.of());
        WindowsWorkspaceSpec full = factory.build(temporary.toString(), AgentPermissionMode.FULL_ACCESS);
        assertTrue(full.writable());
    }
}
