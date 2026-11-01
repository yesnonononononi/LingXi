package com.summit.dp.workflow.infrastructure.tools.memory;

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
import com.summit.dp.workflow.infrastructure.tools.arguments.LoadMemoryArgument;
import lombok.RequiredArgsConstructor;
import org.jspecify.annotations.NonNull;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/** 目录与正文按需读取，避免把整个项目记忆预先塞进上下文。 */
@Component
@RequiredArgsConstructor
@Tool(
        id = ToolCatalog.LOAD_MEMORY,
        name = ToolCatalog.LOAD_MEMORY,
        description = "列出当前项目的记忆 wiki，或读取指定文档。省略 wikiName 获取目录，再按目录中的相对路径读取；不读取全局长期记忆或日记。",
        executor = MemoryWikiLoader.class,
        parameters = @ObjectValue(properties = {
                @ToolProperty(key = "wikiName", value = @Value(type = ValueType.STRING,
                        description = "目录返回的 wiki 相对路径，包含 .md 扩展名；省略时列出目录。"))
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
            throwIf(toolExecution.getArgs() == null || toolExecution.getArgs().isBlank(), "读取记忆 wiki 的参数必须是 JSON 对象");
            LoadMemoryArgument argument = objectMapper.readValue(toolExecution.getArgs(), LoadMemoryArgument.class);
            throwIf(argument == null, "读取记忆 wiki 的参数不能为空");
            throwIf(argument.getWikiName() != null && argument.getWikiName().isBlank(), "记忆 wiki 名称不能为空，列目录请省略 wikiName");

            // 框架会给无工作空间的请求补进程目录，项目记忆必须先确认真实绑定。
            throwIf(ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.WORKSPACE_ID) == null,
                    "当前会话未指定项目，无法读取项目记忆 wiki；仍可继续交流，无需先选择工作空间");

            // 单例执行器必须按调用获取原型，构造器直接注入会把原型固定成共享实例。
            MemoryWikiManager manager = managers.getObject();
            manager.loadWikis(toolExecution.getWorkspace());
            if (argument.getWikiName() == null) {
                return ToolExecuteResult.success(objectMapper.writeValueAsString(manager.getWikis()));
            }
            String detail = manager.findWikiDetail(argument.getWikiName());
            throwIf(detail == null, "未找到记忆 wiki，请省略 wikiName 查看当前项目目录");
            return ToolExecuteResult.success(detail);
        } catch (Exception error) {
            return ToolExecuteResult.err("读取记忆 wiki 失败: " + error.getMessage());
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
