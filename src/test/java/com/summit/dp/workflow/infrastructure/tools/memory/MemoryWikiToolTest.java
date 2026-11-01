package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.test.context.support.TestPropertySourceUtils;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class MemoryWikiToolTest {
    @TempDir Path temporary;
    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void springCreatesAnIndependentIndexForEveryCallAndUsesDedicatedDirectoryConfiguration() throws Exception {
        Path firstRoot = Files.createDirectories(temporary.resolve("first"));
        Path secondRoot = Files.createDirectories(temporary.resolve("second"));
        write(firstRoot, "knowledge/shared.md", "项目甲");
        write(secondRoot, "knowledge/shared.md", "项目乙");
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
            TestPropertySourceUtils.addInlinedPropertiesToEnvironment(context,
                    "lingxi.memory.wiki.relative-location=knowledge",
                    "lingxi.memory.project.relative-location=.lingxi/memory/consistent/memory.md");
            context.registerBean(ObjectMapper.class, () -> new ObjectMapper());
            context.register(MemoryWikiManager.class, MemoryWikiLoader.class);
            context.refresh();

            MemoryWikiManager firstManager = context.getBean(MemoryWikiManager.class);
            MemoryWikiManager secondManager = context.getBean(MemoryWikiManager.class);
            assertNotSame(firstManager, secondManager);
            firstManager.loadWikis(workspace(firstRoot));
            secondManager.loadWikis(workspace(secondRoot));
            assertEquals("项目甲", firstManager.findWikiDetail("shared.md"));
            assertEquals("项目乙", secondManager.findWikiDetail("shared.md"));

            MemoryWikiLoader loader = context.getBean(MemoryWikiLoader.class);
            assertSame(loader, context.getBean(MemoryWikiLoader.class));
            assertEquals("项目甲", read(loader, workspace(firstRoot), "shared.md").getToolOutput());
            assertEquals("项目乙", read(loader, workspace(secondRoot), "shared.md").getToolOutput());
            write(firstRoot, "knowledge/shared.md", "更新后的项目甲");
            assertEquals("更新后的项目甲", read(loader, workspace(firstRoot), "shared.md").getToolOutput());
        }
    }

    @Test
    void overlappingCallsKeepTheirOwnIndexesAfterBothProjectsHaveLoaded() throws Exception {
        Path firstRoot = Files.createDirectories(temporary.resolve("first"));
        Path secondRoot = Files.createDirectories(temporary.resolve("second"));
        write(firstRoot, ".lingxi/wikis/shared.md", "项目甲");
        write(secondRoot, ".lingxi/wikis/shared.md", "项目乙");
        CyclicBarrier loaded = new CyclicBarrier(2);
        List<MemoryWikiManager> created = new ArrayList<>();
        ObjectProvider<MemoryWikiManager> provider = provider();
        when(provider.getObject()).thenAnswer(invocation -> {
            MemoryWikiManager manager = new MemoryWikiManager(".lingxi/wikis") {
                @Override
                public void loadWikis(Workspace workspace) throws IOException {
                    super.loadWikis(workspace);
                    try {
                        loaded.await(5, TimeUnit.SECONDS);
                    } catch (Exception error) {
                        throw new IOException("并发加载未在规定时间内完成", error);
                    }
                }
            };
            synchronized (created) { created.add(manager); }
            return manager;
        });
        MemoryWikiLoader loader = new MemoryWikiLoader(mapper, provider);
        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
            List<Callable<ToolExecuteResult>> calls = List.of(
                    () -> read(loader, workspace(firstRoot), "shared.md"),
                    () -> read(loader, workspace(secondRoot), "shared.md"));
            List<Future<ToolExecuteResult>> results = executor.invokeAll(calls, 10, TimeUnit.SECONDS);
            assertEquals("项目甲", results.get(0).get().getToolOutput());
            assertEquals("项目乙", results.get(1).get().getToolOutput());
        }
        verify(provider, times(2)).getObject();
        assertEquals(2, created.size());
        assertNotSame(created.get(0), created.get(1));
    }

    @Test
    void catalogKeepsNestedDuplicateNamesAndOnlyReadsIndexedMarkdown() throws Exception {
        write(temporary, ".lingxi/wikis/z.md", "根目录");
        write(temporary, ".lingxi/wikis/a/same.md", "甲正文");
        write(temporary, ".lingxi/wikis/b/same.md", "乙正文");
        write(temporary, ".lingxi/wikis/ignored.txt", "非 wiki");
        write(temporary, ".lingxi/wikis/empty.md", "");
        MemoryWikiLoader loader = loader(".lingxi/wikis");
        Workspace workspace = workspace(temporary);

        ToolExecuteResult catalog = execute(loader, workspace, "{}");
        assertTrue(catalog.isSuccess(), catalog.getToolOutput());
        assertEquals(List.of("a/same.md", "b/same.md", "empty.md", "z.md"),
                mapper.readValue(catalog.getToolOutput(), List.class));
        assertEquals("甲正文", read(loader, workspace, "a/same.md").getToolOutput());
        assertEquals("乙正文", read(loader, workspace, "b/same.md").getToolOutput());
        ToolExecuteResult empty = read(loader, workspace, "empty.md");
        assertTrue(empty.isSuccess());
        assertEquals("", empty.getToolOutput());
        for (String name : List.of("same.md", "ignored.txt", "../secret.md", "missing.md")) {
            assertFalse(read(loader, workspace, name).isSuccess(), name);
        }
    }

    @Test
    void missingDirectoryIsEmptyAndNewFilesAppearOnTheNextCall() throws Exception {
        MemoryWikiLoader loader = loader(".lingxi/wikis");
        Workspace workspace = workspace(temporary);
        assertEquals("[]", execute(loader, workspace, "{}").getToolOutput());
        assertFalse(Files.exists(temporary.resolve(".lingxi")));
        write(temporary, ".lingxi/wikis/new.md", "新 wiki");
        assertEquals("新 wiki", read(loader, workspace, "new.md").getToolOutput());
        Files.delete(temporary.resolve(".lingxi/wikis/new.md"));
        assertEquals("[]", execute(loader, workspace, "{}").getToolOutput());
    }

    @Test
    void bridgeDenialIsAnErrorEvenWhenTheHostCanReadTheFile() throws Exception {
        Path document = write(temporary, ".lingxi/wikis/secret.md", "宿主可读的正文");
        WorkspaceFiles files = mock(WorkspaceFiles.class);
        when(files.readString(document.toRealPath(), StandardCharsets.UTF_8)).thenThrow(new IOException("沙箱拒绝读取"));
        Workspace workspace = workspace(temporary);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        when(bridge.files()).thenReturn(files);
        when(workspace.bridge()).thenReturn(bridge);

        ToolExecuteResult result = read(loader(".lingxi/wikis"), workspace, "secret.md");
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("沙箱拒绝读取"));
        verify(files).readString(document.toRealPath(), StandardCharsets.UTF_8);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "null", "[]", "broken", "{\"wikiName\":\" \"}"})
    void malformedArgumentsAreErrors(String arguments) {
        ToolExecuteResult result = execute(loader(".lingxi/wikis"), workspace(temporary), arguments);
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().startsWith("读取记忆 wiki 失败:"));
    }

    @Test
    void absentOrRelativeWorkspaceNeverFallsBackToTheProcessDirectory() {
        assertFalse(execute(loader(".lingxi/wikis"), null, "{}").isSuccess());
        assertFalse(execute(loader(".lingxi/wikis"), workspace(Path.of("relative-project")), "{}").isSuccess());
    }

    @Test
    void aFrameworkFallbackWorkspaceWithoutABusinessBindingCannotExposeProjectMemory() throws Exception {
        write(temporary, ".lingxi/wikis/host.md", "不属于当前会话的项目记忆");
        MemoryWikiLoader loader = loader(".lingxi/wikis");
        Workspace fallback = workspace(temporary);
        assertEquals("不属于当前会话的项目记忆", read(loader, fallback, "host.md").getToolOutput());

        ToolExecuteResult result = loader.execute(ToolExecution.builder().workspace(fallback).args("{}").build());
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("当前会话未指定项目"));
        verify(fallback, times(1)).resolve(anyString());
    }

    @ParameterizedTest
    @ValueSource(strings = {"", " ", ".", "../outside", ".lingxi/../../outside"})
    void invalidDirectoryConfigurationsAreRejected(String directory) {
        assertThrows(ClientException.class, () -> new MemoryWikiManager(directory).loadWikis(workspace(temporary)));
    }

    @Test
    void absoluteDirectoryAndTheOldMemoryFileSettingCannotBeUsedAsAWikiDirectory() throws Exception {
        Path file = write(temporary, ".lingxi/memory/consistent/memory.md", "长期记忆");
        assertThrows(ClientException.class, () -> new MemoryWikiManager(file.toString()).loadWikis(workspace(temporary)));
        assertThrows(ClientException.class, () -> new MemoryWikiManager(".lingxi/memory/consistent/memory.md")
                .loadWikis(workspace(temporary)));
    }

    @Test
    void toolSchemaAllowsDiscoveryAndRegistersTheReaderAsReadOnly() throws Exception {
        MemoryWikiLoader loader = loader(".lingxi/wikis");
        ToolDefinition<MemoryWikiLoader> definition = AnnotatedToolTestDefinitions.create(MemoryWikiLoader.class, loader);
        assertEquals(ToolCatalog.LOAD_MEMORY, definition.name());
        assertSame(loader, definition.executor());
        assertEquals(ConcurrentPolicy.READ_ONLY, definition.concurrentPolicy());
        JsonNode schema = mapper.readTree(definition.parametersJsonSchema());
        assertEquals("string", schema.path("properties").path("wikiName").path("type").asText());
        assertTrue(schema.path("required").isMissingNode() || schema.path("required").isEmpty());
    }

    private MemoryWikiLoader loader(String directory) {
        ObjectProvider<MemoryWikiManager> provider = provider();
        when(provider.getObject()).thenAnswer(invocation -> new MemoryWikiManager(directory));
        return new MemoryWikiLoader(mapper, provider);
    }

    @SuppressWarnings("unchecked")
    private ObjectProvider<MemoryWikiManager> provider() {
        return mock(ObjectProvider.class);
    }

    private Workspace workspace(Path root) {
        Workspace workspace = mock(Workspace.class);
        when(workspace.workDir()).thenReturn(root.toString());
        when(workspace.resolve(anyString())).thenAnswer(invocation -> root.resolve((String) invocation.getArgument(0)));
        when(workspace.bridge()).thenReturn(new LocalWorkspaceBridge(ShellType.POWERSHELL));
        return workspace;
    }

    private Path write(Path root, String relative, String text) throws IOException {
        Path path = root.resolve(relative);
        Files.createDirectories(path.getParent());
        return Files.writeString(path, text, StandardCharsets.UTF_8);
    }

    private ToolExecuteResult read(MemoryWikiLoader loader, Workspace workspace, String name) throws IOException {
        return execute(loader, workspace, mapper.writeValueAsString(Map.of("wikiName", name)));
    }

    private ToolExecuteResult execute(MemoryWikiLoader loader, Workspace workspace, String arguments) {
        return loader.execute(ToolExecution.builder().workspace(workspace).args(arguments)
                .attributes(Map.of(ExecutionAttributes.WORKSPACE_ID, "123")).build());
    }
}
