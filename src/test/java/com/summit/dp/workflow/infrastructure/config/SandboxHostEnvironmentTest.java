package com.summit.dp.workflow.infrastructure.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.sandbox.mxc.MxcSecurityPolicy;
import com.summit.sandbox.mxc.MxcWorkspaceProvider;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedConstruction;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class SandboxHostEnvironmentTest {
    @TempDir Path temporary;

    @Test void windowsKeepsHostIdentityAndExplicitOverridesWithoutChangingSavedSpec() throws Exception {
        MxcSecurityPolicy policy = new MxcSecurityPolicy(List.of("C:\\private"), List.of("C:\\"), true);
        MxcWorkspaceSpec original = new MxcWorkspaceSpec(temporary.toString(), "scope", List.of("C:\\runtime"),
                List.of(), Map.of("PATH", "bundled-tools", "gh_token", "explicit-token"), false, policy);
        MxcWorkspaceSpec runtime = SandboxHostEnvironment.inherit(original, Map.of(
                "Path", "host-tools", "USERPROFILE", "C:\\Users\\host", "APPDATA", "C:\\Users\\host\\AppData\\Roaming",
                "HOME", "C:\\Users\\host", "LOCALAPPDATA", "C:\\Users\\host\\AppData\\Local",
                "GITHUB_TOKEN", "host-token", "GH_TOKEN", "old-token", "DOCKER_CONFIG", "C:\\docker-config",
                "ProgramFiles(x86)", "C:\\Program Files (x86)", "=C:", "C:\\"), true);
        assertEquals("host-token", runtime.environment().get("GITHUB_TOKEN"));
        assertEquals("explicit-token", runtime.environment().get("GH_TOKEN"));
        assertEquals("bundled-tools", runtime.environment().get("PATH"));
        assertFalse(runtime.environment().containsKey("Path"));
        assertEquals("C:\\Users\\host", runtime.environment().get("USERPROFILE"));
        assertEquals("C:\\Users\\host", runtime.environment().get("HOME"));
        assertEquals("C:\\Users\\host\\AppData\\Roaming", runtime.environment().get("APPDATA"));
        assertEquals("C:\\Users\\host\\AppData\\Local", runtime.environment().get("LOCALAPPDATA"));
        assertEquals("C:\\docker-config", runtime.environment().get("DOCKER_CONFIG"));
        assertSame(policy, runtime.securityPolicy());
        assertEquals(original.readonlyPaths(), runtime.readonlyPaths());
        assertEquals(original.readwritePaths(), runtime.readwritePaths());
        assertEquals(original.workDir(), runtime.workDir());
        assertEquals(original.scope(), runtime.scope());
        assertFalse(runtime.writable());
        assertFalse(new ObjectMapper().writeValueAsString(original).contains("host-token"));
        assertEquals(Map.of("PATH", "bundled-tools", "gh_token", "explicit-token"), original.environment());
    }

    @Test void linuxKeepsCaseSensitiveKeysAndHonorsUserDirectoryOverride() {
        MxcWorkspaceSpec original = new MxcWorkspaceSpec(temporary.toString(), "scope", List.of(), List.of(),
                Map.of("HOME", "/explicit", "Path", "separate"));
        MxcWorkspaceSpec runtime = SandboxHostEnvironment.inherit(original,
                Map.of("HOME", "/home/host", "PATH", "/usr/bin", "SSH_AUTH_SOCK", "/run/agent.sock"), false);
        assertEquals("/explicit", runtime.environment().get("HOME"));
        assertEquals("/usr/bin", runtime.environment().get("PATH"));
        assertEquals("separate", runtime.environment().get("Path"));
        assertEquals("/run/agent.sock", runtime.environment().get("SSH_AUTH_SOCK"));
    }

    @Test void providerPassesInheritedEnvironmentOnlyToRuntimeProvider() {
        SandboxProperties properties = new SandboxProperties(temporary, temporary.resolve("state"), null, null, Map.of());
        MxcWorkspaceSpec original = new MxcWorkspaceSpec(temporary.toString());
        Workspace expected = mock(Workspace.class);
        try (MockedConstruction<MxcWorkspaceProvider> providers = mockConstruction(MxcWorkspaceProvider.class,
                (provider, context) -> when(provider.resolve(any())).thenReturn(expected))) {
            assertSame(expected, new ConfiguredSandboxWorkspaceProvider(properties).resolve(original));
            ArgumentCaptor<WorkspaceSpec> request = ArgumentCaptor.forClass(WorkspaceSpec.class);
            verify(providers.constructed().getFirst()).resolve(request.capture());
            MxcWorkspaceSpec runtime = (MxcWorkspaceSpec) request.getValue();
            String key = System.getProperty("os.name").toLowerCase().contains("windows") ? "USERPROFILE" : "HOME";
            assertNotNull(System.getenv(key), "运行测试需要宿主用户目录环境变量");
            assertEquals(System.getenv(key), runtime.environment().get(key));
            assertNotSame(original, runtime);
            assertTrue(original.environment().isEmpty());
        }
    }
}
