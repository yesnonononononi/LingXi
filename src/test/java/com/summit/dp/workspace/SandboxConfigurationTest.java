package com.summit.dp.workspace;

import com.summit.core.workspace.BasicWorkspaceSpec;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.config.SandboxConfiguration;
import com.summit.dp.workflow.infrastructure.config.SandboxProperties;
import com.summit.dp.workspace.application.service.SandboxService;
import com.summit.harness.springbootautoconfigure.config.WorkspaceAutoConfiguration;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import java.nio.file.Path;
import static org.junit.jupiter.api.Assertions.*;

class SandboxConfigurationTest {
    @TempDir Path temporary;
    private final ApplicationContextRunner contexts = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(WorkspaceAutoConfiguration.class)).withUserConfiguration(SandboxConfiguration.class);
    @Test void missingResourcesKeepLocalModeWorkingAndSandboxResolutionFailsClosed() {
        contexts.run(context -> {
            assertNull(context.getStartupFailure());
            WorkspaceResolver resolver = context.getBean(WorkspaceResolver.class);
            assertEquals(temporary.toString(), resolver.resolve(new BasicWorkspaceSpec("local", temporary.toString())).workDir());
            assertThrows(ClientException.class, () -> resolver.resolve(new MxcWorkspaceSpec(temporary.toString())));
            assertFalse(context.getBean(SandboxService.class).inspect().configured());
            assertThrows(ClientException.class, () -> context.getBean(SandboxService.class).check());
        });
    }
    @Test void nativeDeploymentPathsAndExtraGrantsBindWithoutRuntimeDiscovery() {
        String node = temporary.resolve("node.exe").toString();
        contexts.withPropertyValues("lingxi.sandbox.application-directory=" + temporary,
                "lingxi.sandbox.node-executable=" + node,
                "lingxi.sandbox.sdk-directory=" + temporary.resolve("sdk"),
                "lingxi.sandbox.readonly-paths[0]=/tools", "lingxi.sandbox.readwrite-paths[0]=/cache").run(context -> {
            assertNull(context.getStartupFailure());
            SandboxProperties properties = context.getBean(SandboxProperties.class);
            assertEquals(node, properties.nodeExecutable());
            assertTrue(properties.environment().get("PATH").startsWith(temporary.toString()));
            assertEquals("/cache", properties.readwritePaths().getFirst());
            assertTrue(context.getBean(SandboxService.class).inspect().configured());
            assertFalse(context.getBean(SandboxService.class).inspect().ready());
        });
    }
}
