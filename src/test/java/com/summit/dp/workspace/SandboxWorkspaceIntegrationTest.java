package com.summit.dp.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge.CommandResult;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import com.summit.dp.workspace.infrastructure.config.ConfiguredSandboxWorkspaceProvider;
import com.summit.dp.workspace.infrastructure.config.SandboxProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.extension.AnnotatedElementContext;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.io.TempDirFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.io.File;
import java.time.Duration;
import java.util.List;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/** 使用部署方提供的标准 SRT，验证业务档位确实落到沙箱文件权限。 */
@EnabledIfSystemProperty(named = "sandbox.srt.cli", matches = ".+")
class SandboxWorkspaceIntegrationTest {
    @TempDir(factory = InstallationDirectoryFactory.class) Path temporary;
    @TempDir Path state;

    public static class InstallationDirectoryFactory implements TempDirFactory {
        @Override
        public Path createTempDirectory(AnnotatedElementContext element, ExtensionContext context) throws IOException {
            Path parent = Files.createDirectories(Path.of("target/sandbox-installations")).toAbsolutePath().normalize();
            return Files.createTempDirectory(parent, "application-");
        }
    }

    @Test
    void businessModesSupportWorkspaceWritesAndEnforceReadOnlyThroughFilesAndCommands() throws Exception {
        boolean windows = System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win");
        Path nodeSource = Path.of(System.getProperty("sandbox.node.exe", windows ? "node.exe" : "node"));
        if (!Files.isRegularFile(nodeSource)) {
            nodeSource = Arrays.stream(System.getenv("PATH").split(File.pathSeparator))
                    .map(Path::of).map(directory -> directory.resolve(windows ? "node.exe" : "node"))
                    .filter(Files::isRegularFile).findFirst().orElseThrow();
        }
        Path runtime = Files.createDirectories(temporary.resolve("runtime"));
        Path node = Files.copy(nodeSource, runtime.resolve(windows ? "node.exe" : "node"));
        Path root = Files.createDirectories(temporary.resolve("workspace with spaces"));
        SandboxProperties properties = new SandboxProperties(temporary, node, Path.of(System.getProperty("sandbox.srt.cli")),
                state, Duration.ofSeconds(60), List.of());
        ConfiguredSandboxWorkspaceProvider provider = new ConfiguredSandboxWorkspaceProvider(properties, new ObjectMapper());
        WorkspaceConverter converter = new WorkspaceConverter(mock(SettingsProvider.class),
                new SandboxPolicyFactory(properties.allowedDomains()));
        WorkspaceVO view = WorkspaceVO.builder().id(1L).name("project").hostDir(root.toString()).workDir(root.toString()).build();

        Workspace writable = provider.resolve(converter.toSpec(view, WorkspaceType.SAND_BOX, AgentAccessMode.IN_WORKSPACE));
        Path file = writable.resolve("content.txt");
        writable.bridge().writeString(file, "original", StandardCharsets.UTF_8);
        assertEquals("original", writable.bridge().readString(file, StandardCharsets.UTF_8));
        CommandResult allowed = writable.bridge().execute(windows ? "[Console]::Write('business-sandbox')" : "printf business-sandbox",
                writable.workDir(), StandardCharsets.UTF_8, 30, TimeUnit.SECONDS, 4096);
        assertTrue(allowed.isSuccess(), allowed.output());
        assertEquals("business-sandbox", allowed.output());

        Workspace readOnly = provider.resolve(converter.toSpec(view, WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE));
        assertEquals(writable.id(), readOnly.id());
        assertEquals("original", readOnly.bridge().readString(file, StandardCharsets.UTF_8));
        assertThrows(IOException.class, () -> readOnly.bridge().writeString(file, "changed", StandardCharsets.UTF_8));
        assertThrows(IOException.class, () -> readOnly.bridge().createDirectories(root.resolve("forbidden")));
        assertThrows(IOException.class, () -> readOnly.bridge().deleteFile(file));
        String writeCommand = windows
                ? "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('" + file.toString().replace("'", "''") + "', 'changed')"
                : "printf changed > '" + file.toString().replace("'", "'\"'\"'") + "'";
        CommandResult denied = readOnly.bridge().execute(writeCommand, readOnly.workDir(), StandardCharsets.UTF_8,
                30, TimeUnit.SECONDS, 4096);
        assertFalse(denied.isSuccess(), denied.output());
        assertEquals("original", Files.readString(file));
        assertFalse(Files.exists(root.resolve("forbidden")));

        Path outsideFile = Files.writeString(temporary.resolve("another-project.txt"), "outside");
        String outsideWrite = windows
                ? "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('" + outsideFile.toString().replace("'", "''") + "', 'changed')"
                : "printf changed > '" + outsideFile.toString().replace("'", "'\"'\"'") + "'";
        CommandResult outsideDenied = writable.bridge().execute(outsideWrite, writable.workDir(), StandardCharsets.UTF_8,
                30, TimeUnit.SECONDS, 4096);
        assertAll("项目外写入必须被文件工具和原始命令共同拒绝",
                () -> assertThrows(IOException.class, () -> writable.bridge().writeString(outsideFile, "changed", StandardCharsets.UTF_8)),
                () -> assertFalse(outsideDenied.isSuccess(), outsideDenied.output()),
                () -> assertEquals("outside", Files.readString(outsideFile)));
    }
}
