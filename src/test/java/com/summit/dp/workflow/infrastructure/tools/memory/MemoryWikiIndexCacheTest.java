package com.summit.dp.workflow.infrastructure.tools.memory;

import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.dp.workspace.domain.repository.WorkspaceRepository;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class MemoryWikiIndexCacheTest {
    @TempDir Path project;

    @Test
    void concurrentLoadsShareOneSnapshotAndKeepProjectsIsolated() throws Exception {
        Path first = Files.createDirectories(project.resolve("first/wiki"));
        Path second = Files.createDirectories(project.resolve("second/wiki"));
        Files.writeString(first.resolve("shared.md"), "甲");
        Files.writeString(second.resolve("shared.md"), "乙");
        MemoryWikiIndexCache indexes = new MemoryWikiIndexCache();
        try (ExecutorService executor = Executors.newFixedThreadPool(8)) {
            List<Callable<MemoryWikiIndexCache.Index>> calls = IntStream.range(0, 24)
                    .mapToObj(index -> (Callable<MemoryWikiIndexCache.Index>) () -> indexes.load(first.getParent(), first))
                    .toList();
            List<Future<MemoryWikiIndexCache.Index>> results = executor.invokeAll(calls, 10, TimeUnit.SECONDS);
            MemoryWikiIndexCache.Index initial = results.getFirst().get();
            for (Future<MemoryWikiIndexCache.Index> result : results) assertSame(initial, result.get());
            MemoryWikiIndexCache.Index other = indexes.load(second.getParent(), second);
            assertNotSame(initial, other);
            assertEquals(first.resolve("shared.md").toRealPath(), initial.wikis().get("shared.md"));
            assertEquals(second.resolve("shared.md").toRealPath(), other.wikis().get("shared.md"));
            assertThrows(UnsupportedOperationException.class, () -> initial.wikis().clear());
        }
    }

    @Test
    void failedScansCanRetryAfterTheDirectoryIsRepaired() throws Exception {
        Path directory = Files.writeString(project.resolve("wiki"), "目录被文件占用");
        MemoryWikiIndexCache indexes = new MemoryWikiIndexCache();
        assertThrows(RuntimeException.class, () -> indexes.load(project, directory));
        Files.delete(directory);
        Files.createDirectory(directory);
        Files.writeString(directory.resolve("repaired.md"), "已修复");
        assertEquals(List.of("repaired.md"), indexes.load(project, directory).wikis().keySet().stream().toList());
    }

    @Test
    @SuppressWarnings("unchecked")
    void startupWarmsRegisteredProjectsAndAnUnavailableProjectDoesNotBlockOthers() throws Exception {
        Path first = Files.createDirectories(project.resolve("first/wiki"));
        Path second = Files.createDirectories(project.resolve("second/wiki"));
        Files.writeString(first.resolve("first.md"), "甲");
        Files.writeString(second.resolve("second.md"), "乙");
        Path broken = Files.createDirectories(project.resolve("broken"));
        Files.writeString(broken.resolve("wiki"), "不是目录");
        WorkspaceRepository workspaces = mock(WorkspaceRepository.class);
        when(workspaces.findAll()).thenReturn(List.of(new Workspace(1L, "甲", first.getParent().toString()),
                new Workspace(2L, "不可用", broken.toString()), new Workspace(3L, "乙", second.getParent().toString())));
        MemoryWikiIndexCache indexes = new MemoryWikiIndexCache();
        ObjectProvider<MemoryWikiManager> managers = mock(ObjectProvider.class);
        when(managers.getObject()).thenAnswer(invocation -> new MemoryWikiManager("wiki", indexes));

        assertDoesNotThrow(() -> new MemoryWikiStartupLoader(workspaces, managers).run(null));
        Files.writeString(first.resolve("late.md"), "启动后新增");
        Files.writeString(second.resolve("late.md"), "启动后新增");
        MemoryWikiManager manager = new MemoryWikiManager("wiki", indexes);
        manager.loadWikis(new LocalWorkspace("first", first.getParent().toString()));
        assertEquals(List.of("first.md"), manager.getWikis());
        manager.loadWikis(new LocalWorkspace("second", second.getParent().toString()));
        assertEquals(List.of("second.md"), manager.getWikis());
    }
}
