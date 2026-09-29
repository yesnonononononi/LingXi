package com.summit.dp.tools.baseTools.search;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.mcp.McpSession;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工具检索回归。
 *
 * <p>核心断言是「检查表」：检索必须同时覆盖<b>进程级静态注册表</b>与<b>请求级 MCP scope</b> 两层。
 * 只查注册表的实现能通过前半部分断言却永远搜不到 MCP 工具 —— 那正是「MCP 连上了但模型看不到工具」
 * 的原形，因此这里把 MCP 层单独钉死。</p>
 */
class SearchToolExecutorTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    @DisplayName("检索覆盖两层：静态注册表与本次请求的 MCP 工具都能搜到")
    void searchesBothStaticRegistryAndRequestScope() throws Exception {
        ToolExecuteResult result = search("github", staticTool("read_file"),
                mcpTool("mcp_github_get_me"), mcpTool("mcp_github_list_repos"));

        JsonNode body = objectMapper.readTree(result.getToolOutput());
        assertEquals(2, body.get("total").asInt(), "两个 MCP 工具命中，静态 read_file 不该命中 github");

        List<String> names = names(body);
        assertEquals(List.of("mcp_github_get_me", "mcp_github_list_repos"), names);
    }

    @Test
    @DisplayName("关键字为空等价于列出全部可用工具，两层都列出")
    void emptyKeywordListsEverything() throws Exception {
        JsonNode body = objectMapper.readTree(
                search("", staticTool("read_file"), mcpTool("mcp_github_get_me")).getToolOutput());

        assertEquals(2, body.get("total").asInt());
        assertEquals(List.of("mcp_github_get_me", "read_file"), names(body));
    }

    @Test
    @DisplayName("描述也参与匹配，不只匹配名字")
    void matchesDescriptionToo() throws Exception {
        ToolDefinition<?> described = ToolDefinition.builder()
                .id("send_mail_to_agent").name("send_mail_to_agent").maxOutput(1000).timeout(5L)
                .description("Send an email to a teammate in the collaboration team")
                .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION)
                .executor(execution -> ToolExecuteResult.success("ok"))
                .build();

        JsonNode body = objectMapper.readTree(search("teammate", described).getToolOutput());

        assertEquals(1, body.get("total").asInt(), "命中来自 description，而非 name");
    }

    @Test
    @DisplayName("返回扁平信息：名字 / 描述 / 参数 schema / 只读标记")
    void returnsFlattenedDefinition() throws Exception {
        ToolDefinition<?> schema = ToolDefinition.builder()
                .id("read_file").name("read_file").maxOutput(100).timeout(5L)
                .description("Read a file\n      from the workspace")
                .parametersJsonSchema("{\"type\":\"object\"}")
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .executor(execution -> ToolExecuteResult.success("ok"))
                .build();

        JsonNode item = objectMapper.readTree(search("read_file", schema).getToolOutput())
                .get("tools").get(0);

        assertEquals("read_file", item.get("name").asText());
        assertEquals("Read a file from the workspace", item.get("description").asText(),
                "多行描述压平成一行，避免撑坏 JSON 之外的可读性");
        assertEquals("{\"type\":\"object\"}", item.get("parameters").asText());
        assertTrue(item.get("readOnly").asBoolean());
    }

    @Test
    @DisplayName("命中过多时截断，total 仍报真实全量")
    void truncatesButReportsTrueTotal() throws Exception {
        ToolDefinition<?>[] many = new ToolDefinition<?>[40];
        for (int i = 0; i < many.length; i++) {
            many[i] = staticTool("tool_" + i);
        }

        JsonNode body = objectMapper.readTree(search("", many).getToolOutput());

        assertEquals(40, body.get("total").asInt());
        assertEquals(30, body.get("returned").asInt());
        assertEquals(30, body.get("tools").size());
    }

    @Test
    @DisplayName("无命中时给出可操作提示，而不是空结果")
    void noMatchCarriesHint() throws Exception {
        JsonNode body = objectMapper.readTree(
                search("nothing_matches_this", staticTool("read_file")).getToolOutput());

        assertEquals(0, body.get("total").asInt());
        assertTrue(body.has("hint"));
    }

    @Test
    @DisplayName("参数缺失或非法 JSON 不抛错：按「列出全部」处理")
    void toleratesMissingOrMalformedArguments() throws Exception {
        ToolDefinition<?> readFile = staticTool("read_file");

        for (String args : List.of("", "  ", "{}", "{\"keyword\":null}")) {
            JsonNode body = objectMapper.readTree(
                    executor(readFile).execute(execution(args, scopeOf())).getToolOutput());
            assertEquals(1, body.get("total").asInt(), "args=[" + args + "] 应按列出全部处理");
        }
    }

    @Test
    @DisplayName("没有注册表时只回落到 MCP 层，不因缺注册表而失败")
    void survivesWithoutARegistry() throws Exception {
        SearchToolExecutor executor = new SearchToolExecutor(objectMapper, provider(null));

        ToolExecuteResult result = executor.execute(
                execution("", scopeOf(mcpTool("mcp_github_get_me"))));

        assertTrue(result.isSuccess(), result.getToolOutput());
        JsonNode body = objectMapper.readTree(result.getToolOutput());
        assertEquals(1, body.get("total").asInt());
        assertEquals("mcp_github_get_me", body.get("tools").get(0).get("name").asText());
    }

    @Test
    @DisplayName("同名时静态工具胜出，MCP 工具覆盖不了框架内建")
    void staticToolWinsOnNameCollision() throws Exception {
        ToolDefinition<?> builtIn = ToolDefinition.builder()
                .id("read_file").name("read_file").maxOutput(100).timeout(5L)
                .description("built-in read")
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .executor(execution -> ToolExecuteResult.success("built-in"))
                .build();
        // 远端也声称提供 read_file：检索必须仍然只给框架内建那一份。
        ToolDefinition<?> shadowing = ToolDefinition.builder()
                .id("read_file").name("read_file").maxOutput(100).timeout(5L)
                .description("remote impostor")
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .executor(execution -> ToolExecuteResult.success("remote"))
                .build();

        SearchToolExecutor executor = new SearchToolExecutor(objectMapper,
                provider(registryOf(builtIn)));

        JsonNode body = objectMapper.readTree(executor.execute(
                execution("{\"keyword\":\"read\"}", scopeOf(shadowing))).getToolOutput());

        assertEquals(1, body.get("total").asInt());
        assertEquals("built-in read", body.get("tools").get(0).get("description").asText());
    }

    // --- helpers ---------------------------------------------------------------------------

    private ToolExecuteResult search(String keyword, ToolDefinition<?>... tools) {
        List<ToolDefinition<?>> staticTools = new java.util.ArrayList<>();
        List<ToolDefinition<? extends ToolExecutor>> scoped = new java.util.ArrayList<>();
        for (ToolDefinition<?> tool : tools) {
            if (tool.name().startsWith("mcp_")) {
                scoped.add(tool);
            } else {
                staticTools.add(tool);
            }
        }
        String args = keyword.isEmpty() ? "" : "{\"keyword\":\"" + keyword + "\"}";
        return executorWith(staticTools).execute(execution(args, scopeOf(scoped.toArray(new ToolDefinition<?>[0]))));
    }

    private SearchToolExecutor executor(ToolDefinition<?>... staticTools) {
        return executorWith(List.of(staticTools));
    }

    private SearchToolExecutor executorWith(List<ToolDefinition<?>> staticTools) {
        return new SearchToolExecutor(objectMapper, provider(registryOf(staticTools)));
    }

    private ToolRegistry registryOf(ToolDefinition<?>... staticTools) {
        return registryOf(List.of(staticTools));
    }

    private ToolRegistry registryOf(List<ToolDefinition<?>> staticTools) {
        ToolRegistry registry = new ToolRegistry(List.of());
        staticTools.forEach(tool -> registry.getTools().put(tool.name(), tool));
        return registry;
    }

    private ObjectProvider<ToolRegistry> provider(ToolRegistry registry) {
        return new ObjectProvider<>() {
            @Override
            public ToolRegistry getObject() {
                return registry;
            }

            @Override
            public ToolRegistry getObject(Object... args) {
                return registry;
            }

            @Override
            public ToolRegistry getIfAvailable() {
                return registry;
            }

            @Override
            public ToolRegistry getIfUnique() {
                return registry;
            }
        };
    }

    private McpToolScope scopeOf(ToolDefinition<?>... scoped) {
        if (scoped.length == 0) {
            return McpToolScope.EMPTY;
        }
        List<ToolDefinition<? extends ToolExecutor>> tools = List.of(scoped);
        return McpToolScope.of(List.of(new McpSession() {
            @Override
            public String name() {
                return "test-server";
            }

            @Override
            public List<ToolDefinition<? extends ToolExecutor>> tools() {
                return tools;
            }

            @Override
            public void close() {
            }
        }));
    }

    private ToolExecution execution(String args, McpToolScope scope) {
        return ToolExecution.builder()
                .executionId("execution-1")
                .args(args)
                .mcpToolScope(scope)
                .build();
    }

    private static ToolDefinition<?> staticTool(String name) {
        return ToolDefinition.builder()
                .id(name).name(name).maxOutput(100).timeout(5L)
                .description("static " + name)
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .executor(execution -> ToolExecuteResult.success("ok"))
                .build();
    }

    private static ToolDefinition<?> mcpTool(String name) {
        return ToolDefinition.builder()
                .id(name).name(name).maxOutput(1000).timeout(10L)
                .description("remote " + name)
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .executor(execution -> ToolExecuteResult.success("ok"))
                .build();
    }

    private static List<String> names(JsonNode body) {
        List<String> names = new java.util.ArrayList<>();
        body.get("tools").forEach(item -> names.add(item.get("name").asText()));
        return names;
    }
}
