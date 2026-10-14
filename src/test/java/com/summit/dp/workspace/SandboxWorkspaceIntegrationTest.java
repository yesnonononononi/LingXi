package com.summit.dp.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge.CommandResult;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
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
import java.nio.file.FileSystem;
import java.io.File;
import java.time.Duration;
import java.util.List;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 使用部署方提供的标准 SRT，验证业务档位确实落到沙箱文件权限。 */
@EnabledIfSystemProperty(named = "sandbox.srt.cli", matches = ".+")
class SandboxWorkspaceIntegrationTest {
    @TempDir(factory = InstallationDirectoryFactory.class) Path temporary;
    @TempDir Path state;
    @TempDir Path outsideVolume;

    public static class InstallationDirectoryFactory implements TempDirFactory {
        @Override
        public Path createTempDirectory(AnnotatedElementContext element, ExtensionContext context) throws IOException {
            Path parent = Files.createDirectories(Path.of("target/sandbox-installations")).toAbsolutePath().normalize();
            return Files.createTempDirectory(parent, "application-");
        }
    }

    private record Fixture(boolean windows, Path root, ConfiguredSandboxWorkspaceProvider provider,
                           WorkspaceConverter converter, WorkspaceVO view) {}

    private Fixture createFixture() throws IOException {
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
        // 隔离测试的挂载范围，避免集成测试对宿主整盘施加临时 ACL。
        FileSystem fileSystem = mock(FileSystem.class);
        when(fileSystem.getRootDirectories()).thenReturn(List.of(temporary, outsideVolume));
        WorkspaceConverter converter = new WorkspaceConverter(mock(SettingsProvider.class),
                new SandboxPolicyFactory(properties.allowedDomains(), fileSystem));
        WorkspaceVO view = WorkspaceVO.builder().id(1L).name("project").hostDir(root.toString()).workDir(root.toString()).build();
        return new Fixture(windows, root, provider, converter, view);
    }

    @Test
    void fullAccessWritesOutsideProjectThroughFilesAndCommandsAndProtectsFrameworkDirectories() throws Exception {
        Fixture fixture = createFixture();
        Path outside = Files.writeString((fixture.windows() ? outsideVolume : temporary).resolve("outside-project.txt"), "original");
        if (!fixture.windows()) {
            Workspace restricted = fixture.provider().resolve(fixture.converter().toSpec(fixture.view(),
                    WorkspaceType.SAND_BOX, AgentAccessMode.IN_WORKSPACE));
            assertThrows(IOException.class, () -> restricted.bridge().writeString(outside, "changed", StandardCharsets.UTF_8));
        }
        assertEquals("original", Files.readString(outside));
        Workspace workspace = fixture.provider().resolve(fixture.converter().toSpec(fixture.view(),
                WorkspaceType.SAND_BOX, AgentAccessMode.OUT_OF_WORKSPACE));
        assertTrue(workspace.runtimeEnvironment().isolated());
        workspace.bridge().writeString(outside, "from-file-tool", StandardCharsets.UTF_8);
        assertEquals("from-file-tool", Files.readString(outside));
        String command = fixture.windows()
                ? "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('" + outside.toString().replace("'", "''") + "', 'from-command')"
                : "printf from-command > '" + outside.toString().replace("'", "'\"'\"'") + "'";
        CommandResult allowed = workspace.bridge().execute(command, workspace.workDir(), StandardCharsets.UTF_8,
                30, TimeUnit.SECONDS, 4096);
        assertTrue(allowed.isSuccess(), allowed.output());
        assertEquals("from-command", Files.readString(outside));
        Path forbidden = temporary.resolve("resources/sandbox-helpers/forbidden.txt");
        assertThrows(IOException.class, () -> workspace.bridge().writeString(forbidden, "changed", StandardCharsets.UTF_8));
        String protectedWrite = fixture.windows()
                ? "$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('" + forbidden.toString().replace("'", "''") + "', 'changed')"
                : "printf changed > '" + forbidden.toString().replace("'", "'\"'\"'") + "'";
        CommandResult denied = workspace.bridge().execute(protectedWrite, workspace.workDir(), StandardCharsets.UTF_8,
                30, TimeUnit.SECONDS, 4096);
        assertFalse(denied.isSuccess(), denied.output());
        assertFalse(Files.exists(forbidden));
    }

    @Test
    void writableAndReadOnlyModesStartAndApplyExplicitProjectPermissions() throws Exception {
        Fixture fixture = createFixture();
        boolean windows = fixture.windows();
        Path root = fixture.root();
        ConfiguredSandboxWorkspaceProvider provider = fixture.provider();
        WorkspaceConverter converter = fixture.converter();
        WorkspaceVO view = fixture.view();

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
        CommandToolDefinitionExecutor terminal = new CommandToolDefinitionExecutor(new ObjectMapper());
        ToolDefinition<?> definition = ToolDefinition.builder().id(ToolCatalog.EXECUTE_COMMAND)
                .name(ToolCatalog.EXECUTE_COMMAND).executor(terminal).timeout(30L).maxOutput(4096).build();
        String readCommand = windows
                ? "[Console]::Write([IO.File]::ReadAllText('content.txt'))" : "cat content.txt";
        ToolExecuteResult terminalRead = terminal.process(ExecuteCommandRequest.builder().command(readCommand).build(),
                readOnly, definition);
        assertTrue(terminalRead.isSuccess(), terminalRead.toString());
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

        // Windows 的追加 ACL 不保证项目外默认拒绝；仅在具备该边界的后端断言。
        if (windows) return;
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
