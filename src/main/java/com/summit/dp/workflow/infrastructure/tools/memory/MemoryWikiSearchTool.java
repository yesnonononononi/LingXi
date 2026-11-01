package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.core.JsonProcessingException;
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

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 搜索全量索引，返回有界片段；正文仍由读取工具按需加载。
 *
 * <p>参数容错与框架 {@code search_tool} 一致：缺失参数、畸形 JSON、不是 JSON 对象、关键词不是文本，
 * 一律降级为空关键词（列出全部），因为拼错的参数不该把一次查找变成失败回合；
 * 关键词超过 {@link MemoryWikiLimits#MAX_KEYWORD_CHARS} 时截断后继续检索。</p>
 *
 * <p>安全边界不放宽：未绑定项目的会话仍然拒绝检索，避免读到框架补的进程目录里的记忆。</p>
 */
@Component
@RequiredArgsConstructor
@Tool(id = ToolCatalog.SEARCH_WIKI, name = ToolCatalog.SEARCH_WIKI,
        executor = MemoryWikiSearchTool.class,
        description = "按关键词检索当前项目全部 wiki 的名称和正文，不区分大小写。返回 total、returned 和最多 30 个文档名及片段，使用 load_memory 读取命中文档。空关键词、畸形参数或非文本关键词按空关键词处理，列出全部文档名。",
        parameters = @ObjectValue(properties = {
                @ToolProperty(key = "keyword", value = @Value(type = ValueType.STRING,
                        description = "匹配模块名或正文的关键词，不区分大小写；可省略；超过 256 个字符时截断后检索。"))
        }), concurrentPolicy = ConcurrentPolicy.READ_ONLY,
        maxOutput = MemoryWikiLimits.MAX_SEARCH_CHARS, timeout = 30L)
public class MemoryWikiSearchTool implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final ObjectProvider<MemoryWikiManager> managers;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            return search(toolExecution);
        } catch (Exception error) {
            return ToolExecuteResult.err("检索项目 wiki 失败: " + error.getMessage());
        }
    }

    /**
     * 按关键词检索全量索引并返回有界片段。
     *
     * @param toolExecution 本次工具调用，携带共同工作空间与请求属性
     * @return 检索结果 JSON（keyword、total、returned、wikis）
     * @throws IOException 目录加载或正文读取失败
     */
    private ToolExecuteResult search(ToolExecution toolExecution) throws IOException {
        String keyword = keywordOf(toolExecution.getArgs());
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
    }

    /**
     * 取出检索关键词。
     *
     * <p>省略参数、畸形 JSON、不是 JSON 对象、关键词不是文本都返回空关键词（列出全部）；
     * 超过 {@link MemoryWikiLimits#MAX_KEYWORD_CHARS} 的关键词截断到上限后继续检索，避免整轮失败。</p>
     *
     * @param args 模型传入的原始参数文本
     * @return 已 {@code strip} 且不超过上限的关键词；无法取到时为空串
     */
    private String keywordOf(String args) {
        JsonNode argument = argumentOf(args);
        JsonNode value = argument == null ? null : argument.get("keyword");
        String keyword = value != null && value.isTextual() ? value.asText("").strip() : "";
        return keyword.length() > MemoryWikiLimits.MAX_KEYWORD_CHARS
                ? keyword.substring(0, MemoryWikiLimits.MAX_KEYWORD_CHARS)
                : keyword;
    }

    /**
     * 解析参数对象。
     *
     * @param args 模型传入的原始参数文本
     * @return 参数对象；缺失、畸形或不是对象时为 {@code null}
     */
    private JsonNode argumentOf(String args) {
        if (args == null || args.isBlank()) return null;
        try {
            JsonNode argument = objectMapper.readTree(args);
            return argument != null && argument.isObject() ? argument : null;
        } catch (JsonProcessingException malformed) {
            // 畸形参数降级为空关键词，不能把检索变成失败回合。
            return null;
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    public record Match(String wikiName, String snippet) { }

    public record Result(String keyword, int total, int returned, List<Match> wikis) { }
}
