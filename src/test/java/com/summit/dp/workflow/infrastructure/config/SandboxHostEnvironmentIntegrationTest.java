package com.summit.dp.workflow.infrastructure.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.ProcessRunner;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceCommands;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class SandboxHostEnvironmentIntegrationTest {
    @TempDir Path temporary;

    @Test void githubCliUsesTheHostLoginInsideTheSandbox() throws Exception {
        String application = System.getProperty("mxc.application.directory");
        assumeTrue(Boolean.getBoolean("mxc.github.auth") && application != null, "需要显式开启 GitHub 登录态验证");
        assumeTrue(System.getenv("GH_TOKEN") != null || System.getenv("GITHUB_TOKEN") != null, "需要宿主令牌环境变量");
        WorkspaceCommands.CommandResult host = ProcessRunner.run(List.of("gh", "api", "user", "--jq", ".login"),
                null, StandardCharsets.UTF_8, 20, TimeUnit.SECONDS, 1024);
        assertEquals(0, host.exitCode(), host.output());
        assertFalse(host.output().isBlank());
        Path project = Files.createDirectories(temporary.resolve("github-project"));
        SandboxProperties properties = new SandboxProperties(Path.of(application), temporary.resolve("state"), null, null, Map.of());
        MxcWorkspaceSpec original = new SandboxPolicyFactory(properties.environment()).build(project.toString(), AgentAccessMode.IN_WORKSPACE);
        Workspace workspace = new ConfiguredSandboxWorkspaceProvider(properties).resolve(original);
        WorkspaceCommands.CommandResult sandbox = workspace.bridge().commands().execute("gh api user --jq .login", project.toString(),
                StandardCharsets.UTF_8, 20, TimeUnit.SECONDS, 1024);
        assertEquals(0, sandbox.exitCode(), sandbox.output());
        assertEquals(host.output().strip(), sandbox.output().strip());
        assertFalse(original.environment().containsKey("GH_TOKEN"));
        assertFalse(original.environment().containsKey("GITHUB_TOKEN"));
    }

    @Test void nativeCommandInheritsHostContextAndStillCannotReadDeniedFile() throws Exception {
        String application = System.getProperty("mxc.application.directory");
        String canary = System.getenv("LINGXI_SANDBOX_TEST_CREDENTIAL");
        assumeTrue(application != null && canary != null, "需要随包运行资源和专用凭据哨兵");
        Path project = Files.createDirectories(temporary.resolve("project"));
        Path denied = Files.createDirectories(temporary.resolve("private"));
        Path secret = Files.writeString(denied.resolve("secret.txt"), "denied-canary");
        SandboxProperties properties = new SandboxProperties(Path.of(application), temporary.resolve("state"), null, null,
                Map.of("LINGXI_SANDBOX_TEST_OVERRIDE", "explicit"));
        MxcWorkspaceSpec original = new SandboxPolicyFactory(properties.environment(),
                () -> List.of(new SecurityRule(denied.toString(), "PATH", SecurityAction.DENY,
                        SecurityAction.DENY, SecurityAction.DENY, null, true, null)), temporary.resolve("config"),
                properties.runtimeDirectory(), properties.stateDirectory()).build(project.toString(), AgentAccessMode.IN_WORKSPACE);
        assertFalse(original.environment().containsKey("LINGXI_SANDBOX_TEST_CREDENTIAL"));
        Map<String, String> expected = new LinkedHashMap<>();
        expected.put("LINGXI_SANDBOX_TEST_CREDENTIAL", canary);
        expected.put("LINGXI_SANDBOX_TEST_OVERRIDE", "explicit");
        boolean windows = System.getProperty("os.name").toLowerCase().contains("windows");
        for (String key : windows ? List.of("USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP") : List.of("HOME")) {
            assertNotNull(System.getenv(key), "宿主环境缺少 " + key);
            expected.put(key, System.getenv(key));
        }
        ObjectMapper json = new ObjectMapper();
        Files.writeString(project.resolve("identity.cjs"), """
                const fs = require('node:fs');
                const expected = %s;
                for (const [key, value] of Object.entries(expected)) {
                    if (process.env[key] !== value) throw new Error('environment mismatch: ' + key);
                }
                let refused = false;
                try { fs.readFileSync(%s); } catch (error) { refused = error.code === 'EACCES' || error.code === 'EPERM'; }
                if (!refused) throw new Error('denied file was accessible');
                console.log('identity-and-denial-ok');
                """.formatted(json.writeValueAsString(expected), json.writeValueAsString(secret.toString())));
        Workspace workspace = new ConfiguredSandboxWorkspaceProvider(properties).resolve(original);
        WorkspaceCommands.CommandResult result = workspace.bridge().commands().execute("node identity.cjs", project.toString(),
                StandardCharsets.UTF_8, 15, TimeUnit.SECONDS, 2048);
        assertEquals(0, result.exitCode(), result.output());
        assertEquals("identity-and-denial-ok", result.output().strip());
        assertFalse(json.writeValueAsString(original).contains(canary));
    }
}
