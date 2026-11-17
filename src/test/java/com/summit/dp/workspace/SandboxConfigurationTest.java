package com.summit.dp.workspace;

import com.summit.core.workspace.BasicWorkspaceSpec;
import com.summit.core.workspace.WorkspaceProvider;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.infrastructure.config.SandboxConfiguration;
import com.summit.dp.workflow.infrastructure.config.SandboxProperties;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.harness.springbootautoconfigure.config.WorkspaceAutoConfiguration;
import com.summit.sandbox.windows.WindowsWorkspaceProvider;
import com.summit.sandbox.windows.WindowsWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class SandboxConfigurationTest {
    @TempDir Path temporary;
    private final ApplicationContextRunner contexts = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(WorkspaceAutoConfiguration.class))
            .withUserConfiguration(SandboxConfiguration.class);

    @Test void localModeWorksAndWindowsWorkspaceProviderIsRegistered() {
        contexts.run(context -> {
            assertNull(context.getStartupFailure());
            WorkspaceResolver resolver = context.getBean(WorkspaceResolver.class);
            assertEquals(temporary.toString(), resolver.resolve(new BasicWorkspaceSpec("local", temporary.toString())).workDir());
            assertTrue(context.getBeansOfType(WorkspaceProvider.class).values().stream()
                    .anyMatch(provider -> WindowsWorkspaceProvider.TYPE.equals(provider.type())));
        });
    }

    @Test void nativeDeploymentResourcesAndEnvironmentBindToWindowsWorkspaceSpec() throws Exception {
        Path application = temporary.resolve("Installed LX");
        Path state = temporary.resolve("Writable State");
        Path runtime = application.resolve("resources/runtime");
        Files.createDirectories(runtime);
        Files.createDirectories(state);
        contexts.withPropertyValues("lingxi.sandbox.application-directory=" + application,
                "lingxi.sandbox.state-directory=" + state,
                "lingxi.sandbox.environment.LANG=C.UTF-8").run(context -> {
            assertNull(context.getStartupFailure());
            SandboxProperties properties = context.getBean(SandboxProperties.class);
            assertEquals(state, properties.stateDirectory());
            boolean windows = System.getProperty("os.name").toLowerCase().contains("windows");
            assertEquals(runtime.resolve(windows ? "node/node.exe" : "node/node").toString(), properties.nodeExecutable());
            assertTrue(properties.environment().get("PATH").startsWith(runtime.resolve("node").toString()));
            if (windows) assertTrue(properties.environment().get("PATH").contains(runtime.resolve("git/cmd").toString()));
            SandboxPolicyFactory factory = context.getBean(SandboxPolicyFactory.class);
            WindowsWorkspaceSpec spec = factory.build(temporary.resolve("project").toString(), AgentPermissionMode.APPROVAL_REQUIRED);
            assertEquals(properties.environment(), spec.environment());
            assertEquals("C.UTF-8", spec.environment().get("LANG"));
        });
    }
}
