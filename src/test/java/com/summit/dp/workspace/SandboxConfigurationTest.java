package com.summit.dp.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.workspace.BasicWorkspaceSpec;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workspace.infrastructure.config.SandboxConfiguration;
import com.summit.dp.workspace.infrastructure.config.SandboxProperties;
import com.summit.harness.springbootautoconfigure.config.WorkspaceAutoConfiguration;
import com.summit.sandbox.SandboxWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class SandboxConfigurationTest {
    @TempDir Path temporary;
    private final ApplicationContextRunner contexts = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(WorkspaceAutoConfiguration.class))
            .withUserConfiguration(SandboxConfiguration.class).withBean(ObjectMapper.class, ObjectMapper::new);

    @Test
    void missingSandboxResourcesDoNotBreakLocalModeAndNeverFallBackForSandboxRequests() {
        contexts.run(context -> {
            assertNull(context.getStartupFailure());
            WorkspaceResolver resolver = context.getBean(WorkspaceResolver.class);
            assertEquals(temporary.toString(), resolver.resolve(new BasicWorkspaceSpec("local", temporary.toString())).workDir());
            ClientException failure = assertThrows(ClientException.class,
                    () -> resolver.resolve(SandboxWorkspaceSpec.of(temporary.toString(), null)));
            assertTrue(failure.getMessage().contains("沙箱运行资源未配置"));
        });
    }

    @Test
    void deploymentPathsAndDomainRulesAreBoundWithoutHostInstallationDiscovery() {
        contexts.withPropertyValues("lingxi.sandbox.application-directory=" + temporary,
                "lingxi.sandbox.node-exe=" + temporary.resolve("node.exe"),
                "lingxi.sandbox.srt-cli=" + temporary.resolve("dist/cli.js"),
                "lingxi.sandbox.allowed-domains[0]=api.example.test").run(context -> {
            assertNull(context.getStartupFailure());
            SandboxProperties properties = context.getBean(SandboxProperties.class);
            assertEquals(temporary, properties.applicationDirectory());
            assertEquals(temporary.resolve("node.exe"), properties.nodeExe());
            assertEquals("api.example.test", properties.allowedDomains().getFirst());
        });
    }
}
