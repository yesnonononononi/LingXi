package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workspace.application.convert.LingXiWorkspaceSpec;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** wiki 目录索引进 memory：有界、不含正文、失败不阻断。 */
class MemoryWikiIndexLoaderTest {

    @TempDir
    Path project;

    private final ObjectMapper json = new JsonConfig().objectMapper();

    @SuppressWarnings("unchecked")
    private final ObjectProvider<MemoryWikiManager> managers = mock(ObjectProvider.class);

    private final WorkspaceResolver workspaces = mock(WorkspaceResolver.class);

    @Test
    @DisplayName("目录按上限裁剪成一条记忆，wiki 正文一概不进去")
    void loadsBoundedCatalogAsOneMemoryBody() throws Exception {
        Path directory = Files.createDirectories(project.resolve("wiki"));
        for (int index = 0; index < 40; index++) {
            Files.writeString(directory.resolve("module-%02d.md".formatted(index)), "不应进入初始上下文的正文".repeat(1000));
        }

        List<String> memory = loader().load(spec(project));

        assertEquals(1, memory.size());
        String body = memory.get(0);
        assertTrue(body.contains("\"total\":40"), body);
        assertTrue(body.contains("\"returned\":30"), body);
        assertTrue(body.contains("module-29.md"), body);
        assertFalse(body.contains("module-30.md"), "目录只展示 30 条");
        assertFalse(body.contains("不应进入初始上下文的正文"), "正文必须按需读取");
        assertTrue(body.contains("search_wiki"), body);
        assertTrue(body.contains("load_memory"), body);
    }

    @Test
    @DisplayName("未绑定工作区时不产生记忆，也不去拉记忆管理器")
    void noWorkspaceMeansNoMemory() {
        assertEquals(List.of(), loader().load(null));

        verifyNoInteractions(managers, workspaces);
    }

    @Test
    @DisplayName("目录读取失败只少一段记忆，不抛异常")
    void directoryFailureStaysNonBlocking() {
        MemoryWikiIndexLoader loader = loader();
        doThrow(new IllegalStateException("目录暂时不可用")).when(workspaces).resolve(any());

        assertEquals(List.of(), loader.load(spec(project)));
    }

    private MemoryWikiIndexLoader loader() {
        when(managers.getObject()).thenAnswer(invocation -> new MemoryWikiManager("wiki", new MemoryWikiIndexCache()));
        when(workspaces.resolve(any())).thenAnswer(invocation -> {
            WorkspaceSpec workspace = invocation.getArgument(0);
            return new LocalWorkspace("bound", workspace.workDir());
        });
        return new MemoryWikiIndexLoader(managers, workspaces, json);
    }

    private WorkspaceSpec spec(Path root) {
        return new LingXiWorkspaceSpec("local", root.toString(), Map.of());
    }
}