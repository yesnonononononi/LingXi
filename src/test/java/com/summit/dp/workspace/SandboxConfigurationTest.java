package com.summit.dp.workspace;

import com.summit.core.workspace.BasicWorkspaceSpec;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.config.SandboxConfiguration;
import com.summit.dp.workflow.infrastructure.config.SandboxProperties;
import com.summit.dp.workspace.application.service.SandboxService;
import com.summit.harness.springbootautoconfigure.config.WorkspaceAutoConfiguration;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.io.FileSystemResource;
import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.stream.Stream;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.junit.jupiter.api.Assertions.*;

class SandboxConfigurationTest {
    @TempDir Path temporary;
    private final ApplicationContextRunner contexts = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(WorkspaceAutoConfiguration.class)).withUserConfiguration(SandboxConfiguration.class);

    @Test void developmentProfileLoadsPreparedRuntimeWithoutCommandLinePaths() throws Exception {
        assumeTrue(Boolean.getBoolean("mxc.development"), "需要准备本机开发运行资源");
        contexts.withInitializer(context -> {
            try {
                new YamlPropertySourceLoader().load("development-sandbox",
                        new FileSystemResource(System.getProperty("mxc.development.config", "src/main/resources/application-dev.yaml")))
                        .forEach(source -> context.getEnvironment().getPropertySources().addLast(source));
            } catch (IOException failure) { throw new IllegalStateException(failure); }
        }).run(context -> {
            assertNull(context.getStartupFailure());
            SandboxProperties properties = context.getBean(SandboxProperties.class);
            assertTrue(Files.isRegularFile(Path.of(properties.nodeExecutable())), "开发配置必须指向 Node 可执行文件");
            assertTrue(Files.isRegularFile(Path.of(properties.sdkDirectory(), "package.json")), "开发配置必须指向实际 SDK");
            assertTrue(context.getBean(SandboxService.class).check().ready());
        });
    }

    @Test void capabilityCheckDoesNotCreateTheConfiguredApplicationDirectory() throws Exception {
        String node = System.getProperty("mxc.node");
        String sdk = System.getProperty("mxc.sdk");
        assumeTrue(node != null && sdk != null, "需要宿主 MXC 运行资源");
        Path absent = temporary.resolve("no-workspace-probe");
        contexts.withPropertyValues("lingxi.sandbox.application-directory=" + absent,
                "lingxi.sandbox.node-executable=" + node, "lingxi.sandbox.sdk-directory=" + sdk).run(context -> {
            assertTrue(context.getBean(SandboxService.class).check().ready());
            assertFalse(Files.exists(absent));
        });
        try (Stream<Path> files = Files.list(temporary)) { assertEquals(0, files.count()); }
    }
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
    @Test void nativeDeploymentResourcesAndEnvironmentBindWithoutExtraDirectoryGrants() {
        String node = temporary.resolve("node.exe").toString();
        contexts.withPropertyValues("lingxi.sandbox.application-directory=" + temporary,
                "lingxi.sandbox.node-executable=" + node,
                "lingxi.sandbox.sdk-directory=" + temporary.resolve("sdk"),
                "lingxi.sandbox.environment.LANG=C.UTF-8").run(context -> {
            assertNull(context.getStartupFailure());
            SandboxProperties properties = context.getBean(SandboxProperties.class);
            assertEquals(node, properties.nodeExecutable());
            assertTrue(properties.environment().get("PATH").startsWith(temporary.toString()));
            SandboxPolicyFactory factory = context.getBean(SandboxPolicyFactory.class);
            MxcWorkspaceSpec spec = factory.build(temporary.resolve("project").toString(), AgentAccessMode.IN_WORKSPACE);
            assertEquals(properties.environment(), spec.environment());
            assertEquals("C.UTF-8", spec.environment().get("LANG"));
            assertTrue(spec.readonlyPaths().isEmpty());
            assertTrue(spec.readwritePaths().isEmpty());
            assertFalse(factory.build(spec.workDir(), AgentAccessMode.READ_ONLY_IN_WORKSPACE).writable());
            assertThrows(ClientException.class, () -> factory.build(spec.workDir(), AgentAccessMode.OUT_OF_WORKSPACE));
            assertTrue(context.getBean(SandboxService.class).inspect().configured());
            assertFalse(context.getBean(SandboxService.class).inspect().ready());
        });
    }
}
