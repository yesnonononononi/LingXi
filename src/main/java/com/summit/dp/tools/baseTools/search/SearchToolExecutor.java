package com.summit.dp.tools.baseTools.search;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.tools.baseTools.arguments.SearchToolArgument;
import lombok.AllArgsConstructor;
import lombok.NonNull;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;

/**
 * 工具检索：按关键字模糊查找本次执行可调用的工具，返回扁平信息。
 *
 * <p>数据源是两层：进程级 {@link ToolRegistry} 与本次请求的 {@link McpToolScope} —— MCP 工具名
 * 要等服务器握手后才存在，无法预先写进白名单，所以给模型一个按需检索的入口，而不是把全部
 * 工具定义塞进上下文。</p>
 */
@Component
@AllArgsConstructor
public class SearchToolExecutor implements ToolExecutor {

    /** 命中过多时截断，避免把上下文一次性塞满。 */
    private static final int MAX_MATCHES = 30;

    private final ObjectMapper objectMapper;
    private final ObjectProvider<ToolRegistry> toolRegistry;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            return search(toolExecution);
        } catch (Exception e) {
            return ToolExecuteResult.err("工具检索遇到错误:" + e);
        }
    }

    private ToolExecuteResult search(ToolExecution toolExecution) throws JsonProcessingException {
        String keyword = keywordOf(toolExecution).toLowerCase(Locale.ROOT).strip();

        List<ToolDefinition<?>> matched = callableTools(toolExecution).values().stream()
                .filter(tool -> matches(tool, keyword))
                .sorted(Comparator.comparing(ToolDefinition::name))
                .toList();

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("total", matched.size());
        body.put("returned", Math.min(matched.size(), MAX_MATCHES));
        body.put("tools", matched.stream().limit(MAX_MATCHES).map(SearchToolExecutor::flatten).toList());
        if (matched.isEmpty()) {
            body.put("hint", "没有匹配的工具，可换关键字重试；关键字为空会列出全部可用工具");
        }

        return ToolExecuteResult.success(objectMapper.writeValueAsString(body));
    }

    /**
     * 本次执行可调用的工具：静态注册表 ∪ 本次请求的 MCP scope。同名时静态工具胜出，
     * 与 {@code ModelRequestFactory} 的可见性口径一致。
     */
    private Map<String, ToolDefinition<?>> callableTools(ToolExecution toolExecution) {
        Map<String, ToolDefinition<?>> tools = new LinkedHashMap<>();

        ToolRegistry registry = toolRegistry.getObject();
        if (registry.getTools() != null) {
            tools.putAll(registry.getTools());
        }

        McpToolScope scope = toolExecution.requireMcpToolScope();
        scope.getTools().forEach(tool -> tools.putIfAbsent(tool.name(), tool));

        return tools;
    }

    private static boolean matches(ToolDefinition<?> tool, String keyword) {
        if (keyword.isEmpty()) {
            return true;
        }
        if (tool.name().toLowerCase(Locale.ROOT).contains(keyword)) {
            return true;
        }
        String description = tool.description();
        return description != null && description.toLowerCase(Locale.ROOT).contains(keyword);
    }

    /** 扁平化：只给模型判断「要不要用、怎么用」所需的最小信息。 */    private static Map<String, Object> flatten(ToolDefinition<?> tool) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("name", tool.name());
        item.put("description", normalize(tool.description()));
        item.put("parameters", normalize(tool.parametersJsonSchema()));
        item.put("readOnly", tool.readOnly());
        return item;
    }

    /** 空参数、空对象、缺失关键字都按「列出全部」处理，不因为参数缺失而失败。 */
    private String keywordOf(ToolExecution toolExecution) throws JsonProcessingException {
        String args = toolExecution.getArgs();
        if (args == null || args.isBlank()) {
            return "";
        }
        SearchToolArgument argument = objectMapper.readValue(args, SearchToolArgument.class);
        return Objects.toString(argument == null ? null : argument.getKeyword(), "");
    }

    private static String normalize(String text) {
        return text == null ? "" : text.strip().replaceAll("\\s+", " ");
    }
}
