package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class MemoryWikiSearchTest {
    @TempDir Path project;
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void initialCatalogStopsAtThirtyAndSearchFindsContentBeyondThatWindow() throws Exception {
        Path wikis = Files.createDirectories(project.resolve("wiki"));
        for (int index = 0; index < 40; index++) {
            Files.writeString(wikis.resolve("module-%02d.md".formatted(index)), index == 39 ? "独有关键词 SnowFlake" : "普通模块");
        }
        ObjectProvider<MemoryWikiManager> managers = managers();
        MemoryWikiLoader reader = new MemoryWikiLoader(json, managers);
        Workspace workspace = new LocalWorkspace("project", project.toString());
        ToolExecuteResult catalog = reader.execute(call(workspace, "{}"));
        assertTrue(catalog.isSuccess(), catalog.getToolOutput());
        assertEquals(30, json.readTree(catalog.getToolOutput()).size());
        assertFalse(catalog.getToolOutput().contains("module-39.md"));

        MemoryWikiSearchTool search = new MemoryWikiSearchTool(json, managers);
        ToolExecuteResult result = search.execute(call(workspace, "{\"keyword\":\"snowflake\"}"));
        assertTrue(result.isSuccess(), result.getToolOutput());
        JsonNode found = json.readTree(result.getToolOutput());
        assertEquals(1, found.path("total").asInt());
        assertEquals(1, found.path("returned").asInt());
        assertEquals("module-39.md", found.path("wikis").get(0).path("wikiName").asText());
        assertTrue(found.path("wikis").get(0).path("snippet").asText().contains("SnowFlake"));

        JsonNode all = json.readTree(search.execute(call(workspace, "{}")).getToolOutput());
        assertEquals(40, all.path("total").asInt());
        assertEquals(30, all.path("returned").asInt());
        assertTrue(all.path("wikis").get(0).path("snippet").asText().isEmpty());
    }

    @Test
    void nameAndBodyMatchesReturnBoundedSnippetsAndAccurateCounts() throws Exception {
        Path wikis = Files.createDirectories(project.resolve("wiki"));
        Files.writeString(wikis.resolve("STORAGE.md"), "a".repeat(20_000));
        Files.writeString(wikis.resolve("checkpoint.md"), "x".repeat(20_000) + "storage details" + "z".repeat(20_000));
        MemoryWikiSearchTool search = new MemoryWikiSearchTool(json, managers());
        Workspace workspace = new LocalWorkspace("project", project.toString());
        ToolExecuteResult result = search.execute(call(workspace, "{\"keyword\":\"storage\"}"));
        JsonNode found = json.readTree(result.getToolOutput());
        assertTrue(result.isSuccess());
        assertEquals(2, found.path("total").asInt());
        assertEquals(2, found.path("returned").asInt());
        for (JsonNode hit : found.path("wikis")) assertTrue(hit.path("snippet").asText().length() <= 160);
        assertTrue(result.getToolOutput().length() <= MemoryWikiLimits.MAX_SEARCH_CHARS);
        assertEquals(0, json.readTree(search.execute(call(workspace, "{\"keyword\":\"missing\"}")).getToolOutput()).path("total").asInt());
    }

    @Test
    void catalogAlsoBoundsLongPathsAndEscapedNames() throws Exception {
        List<String> names = IntStream.range(0, 50).mapToObj(index -> "deep/" + "\\\"".repeat(150) + index + ".md").toList();
        List<String> loaded = MemoryWikiLimits.limitNames(names);
        assertFalse(loaded.isEmpty());
        assertTrue(loaded.size() < MemoryWikiLimits.MAX_ENTRIES);
        assertTrue(json.writeValueAsString(loaded).length() <= MemoryWikiLimits.MAX_CATALOG_CHARS);
        assertTrue(names.containsAll(loaded));
    }

    @Test
    void searchCharacterBudgetKeepsTheReturnedJsonComplete() throws Exception {
        ObjectProvider<MemoryWikiManager> managers = managers();
        MemoryWikiManager manager = mock(MemoryWikiManager.class);
        when(managers.getObject()).thenReturn(manager);
        when(manager.getWikis()).thenReturn(IntStream.range(0, 40)
                .mapToObj(index -> "deep/".repeat(200) + index + ".md").toList());
        when(manager.findWikiDetail(anyString())).thenReturn("needle " + "\\\"\n".repeat(100));
        MemoryWikiSearchTool search = new MemoryWikiSearchTool(json, managers);
        ToolExecuteResult result = search.execute(call(null, "{\"keyword\":\"needle\"}"));
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().length() <= MemoryWikiLimits.MAX_SEARCH_CHARS);
        JsonNode found = json.readTree(result.getToolOutput());
        assertEquals(40, found.path("total").asInt());
        assertTrue(found.path("returned").asInt() > 0);
        assertTrue(found.path("returned").asInt() < 30);
        assertEquals(found.path("returned").asInt(), found.path("wikis").size());
    }

    @Test
    void malformedArgumentsAndUnselectedProjectsReturnOrdinaryToolErrors() {
        ObjectProvider<MemoryWikiManager> managers = managers();
        MemoryWikiSearchTool search = new MemoryWikiSearchTool(json, managers);
        for (String args : List.of("null", "[]", "invalid", "{\"keyword\":42}", "{\"keyword\":\"" + "a".repeat(257) + "\"}")) {
            ToolExecuteResult result = search.execute(call(null, args));
            assertFalse(result.isSuccess());
            assertFalse(result.isPromise());
        }
        ToolExecuteResult unselected = search.execute(ToolExecution.builder().args("{}").build());
        assertFalse(unselected.isSuccess());
        assertFalse(unselected.isPromise());
        assertTrue(unselected.getToolOutput().contains("仍可继续交流"));
        verify(managers, never()).getObject();
    }

    @SuppressWarnings("unchecked")
    private ObjectProvider<MemoryWikiManager> managers() {
        ObjectProvider<MemoryWikiManager> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenAnswer(invocation -> new MemoryWikiManager("wiki"));
        return provider;
    }

    private ToolExecution call(Workspace workspace, String args) {
        return ToolExecution.builder().workspace(workspace).args(args)
                .attributes(Map.of(ExecutionAttributes.WORKSPACE_ID, "101")).build();
    }
}
