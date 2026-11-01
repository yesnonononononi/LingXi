package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** 搜索全量索引，返回有界片段；正文仍由读取工具按需加载。 */
@Component
@RequiredArgsConstructor
@Tool(id = ToolCatalog.SEARCH_WIKI, name = ToolCatalog.SEARCH_WIKI,
        executor = MemoryWikiSearchTool.class,
        description = "按关键词检索当前项目全部 wiki 的名称和正文，不区分大小写。返回 total、returned 和最多 30 个文档名及片段，使用 load_memory 读取命中文档。空关键词列出目录。",
        parameters = @ObjectValue(properties = {
                @ToolProperty(key = "keyword", value = @Value(type = ValueType.STRING,
                        description = "匹配模块名或正文的关键词；可省略。"))
        }), concurrentPolicy = ConcurrentPolicy.READ_ONLY,
        maxOutput = MemoryWikiLimits.MAX_SEARCH_CHARS, timeout = 30L)
public class MemoryWikiSearchTool implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final ObjectProvider<MemoryWikiManager> managers;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            String args = toolExecution.getArgs();
            JsonNode argument = args == null || args.isBlank() ? objectMapper.createObjectNode() : objectMapper.readTree(args);
            throwIf(argument == null || !argument.isObject(), "检索 wiki 的参数必须是 JSON 对象");
            JsonNode value = argument.get("keyword");
            throwIf(value != null && !value.isNull() && !value.isTextual(), "检索 wiki 的关键词必须是文本");
            String keyword = value == null || value.isNull() ? "" : value.asText().strip();
            throwIf(keyword.length() > 256, "检索 wiki 的关键词不能超过 256 个字符");
            String normalized = keyword.toLowerCase(Locale.ROOT);
            throwIf(ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.WORKSPACE_ID) == null,
                    "当前会话未指定项目，无法检索项目 wiki；仍可继续交流，无需先选择工作空间");

            MemoryWikiManager manager = managers.getObject();
            manager.loadWikis(toolExecution.getWorkspace());
            List<Match> matches = new ArrayList<>();
            int total = 0;
            for (String name : manager.getWikis()) {
                // 空关键词只列名称，不为目录披露读取全部正文。
                String content = normalized.isEmpty() ? "" : manager.findWikiDetail(name);
                int position = content.toLowerCase(Locale.ROOT).indexOf(normalized);
                if (!name.toLowerCase(Locale.ROOT).contains(normalized) && position < 0) continue;
                total++;
                if (matches.size() >= MemoryWikiLimits.MAX_ENTRIES) continue;
                int start = Math.max(0, position - 40);
                String snippet = content.substring(start, Math.min(content.length(), start + 160)).replaceAll("\\s+", " ");
                Match match = new Match(name, snippet);
                matches.add(match);
                // 预留计数字段增长，保证最终仍为完整 JSON，不能依赖框架截断字符串。
                if (objectMapper.writeValueAsString(new Result(keyword, total, matches.size(), matches)).length()
                        > MemoryWikiLimits.MAX_SEARCH_CHARS - 64) matches.removeLast();
            }
            return ToolExecuteResult.success(objectMapper.writeValueAsString(new Result(keyword, total, matches.size(), matches)));
        } catch (Exception error) {
            return ToolExecuteResult.err("检索项目 wiki 失败: " + error.getMessage());
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    public record Match(String wikiName, String snippet) { }

    public record Result(String keyword, int total, int returned, List<Match> wikis) { }
}
