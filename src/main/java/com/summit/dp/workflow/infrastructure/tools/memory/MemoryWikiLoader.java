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

/**
 * 目录与正文按需读取，避免把整个项目记忆预先塞进上下文。
 *
 * <p>返回体分两种：省略 {@code wikiName} 时返回目录 JSON 对象
 * {@code {"total":n,"returned":m,"wikis":[...]}}，{@code total} 与 {@code returned} 不同即表示目录被裁剪；
 * 指定 {@code wikiName} 时返回该 wiki 的正文。</p>
 *
 * <p>容错策略与框架 {@code list_mcp_tools} 一致：参数畸形、不是 JSON 对象、{@code wikiName} 不是文本，
 * 一律降级为「列目录」，因为一次拼错的参数不该把一次查找变成失败回合。安全边界不放宽：
 * 未绑定工作空间、显式传空 wikiName、wiki 指向目录外部仍然拒绝。</p>
 */
@Component
@RequiredArgsConstructor
@Tool(
        id = ToolCatalog.LOAD_MEMORY,
        name = ToolCatalog.LOAD_MEMORY,
        description = "读取当前项目的记忆 wiki 正文。省略 wikiName 时列出目录，返回 JSON 对象：total 为全部 wiki 数、"
                + "returned 为本次返回数（最多 30 条）、wikis 为 wiki 名称列表；total 大于 returned 说明目录被裁剪，"
                + "请用 search_wiki 按关键词检索全部 wiki。",
        executor = MemoryWikiLoader.class,
        parameters = @ObjectValue(properties = {
                @ToolProperty(key = "wikiName", value = @Value(type = ValueType.STRING,
                        description = "wiki 名称，相对 wiki 根目录、含 .md 扩展名，如 记忆系统.md 或 子目录/模块.md；"
                                + "不要带 .lingxi/memory/wiki 前缀；省略时列出目录。"))
        }),
        concurrentPolicy = ConcurrentPolicy.READ_ONLY,
        maxOutput = 5_000,
        timeout = 30L)
public class MemoryWikiLoader implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final ObjectProvider<MemoryWikiManager> managers;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            return load(toolExecution);
        } catch (Exception error) {
            return ToolExecuteResult.err("读取记忆 wiki 失败: " + error.getMessage());
        }
    }

    /**
     * 按参数分派：没有可用 wikiName 时列目录，否则返回正文。
     *
     * @param toolExecution 本次工具调用，携带共同工作空间与请求属性
     * @return 目录 JSON 或 wiki 正文
     * @throws IOException 目录加载或正文读取失败
     */
    private ToolExecuteResult load(ToolExecution toolExecution) throws IOException {
        String wikiName = wikiNameOf(toolExecution.getArgs());
        // 显式传空串与「省略」语义不同，必须继续拒绝，不能一并降级成列目录。
        throwIf(wikiName != null && wikiName.isBlank(), "记忆 wiki 名称不能为空，列目录请省略 wikiName");

        // 框架会给无工作空间的请求补进程目录，项目记忆必须先确认真实绑定。
        throwIf(ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.WORKSPACE_ID) == null,
                "当前会话未指定项目，无法读取项目记忆 wiki；仍可继续交流，无需先选择工作空间");

        // 单例执行器必须按调用获取原型，构造器直接注入会把原型固定成共享实例。
        MemoryWikiManager manager = managers.getObject();
        manager.loadWikis(toolExecution.getWorkspace());
        if (wikiName == null) {
            return ToolExecuteResult.success(objectMapper.writeValueAsString(manager.catalog()));
        }
        String detail = manager.findWikiDetail(wikiName.strip());
        throwIf(detail == null, "未找到记忆 wiki，请省略 wikiName 查看当前项目目录");
        return ToolExecuteResult.success(detail);
    }

    /**
     * 从参数中取出 wikiName。
     *
     * <p>缺失参数、畸形 JSON、不是 JSON 对象、{@code wikiName} 不是文本一律返回 {@code null}，
     * 由调用方降级为列目录；只有这样，模型拼错的参数才不会被整轮判为失败。
     * 显式空串会原样返回，交给调用方拒绝。</p>
     *
     * @param args 模型传入的原始参数文本
     * @return {@code wikiName} 文本；无法取到时为 {@code null}
     */
    private String wikiNameOf(String args) {
        JsonNode argument = argumentOf(args);
        if (argument == null) return null;
        JsonNode value = argument.get("wikiName");
        if (value == null || value.isNull() || !value.isTextual()) return null;
        return value.asText("");
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
            // 畸形参数不是错误回合，由调用方降级为列目录。
            return null;
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
