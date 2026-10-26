package com.summit.dp.workflow.infrastructure.tools.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.arguments.WebSearchArguments;
import lombok.AllArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

/**
 * web_search 的工具执行器：解析参数、调用 {@link WebSearchEngine}、包装执行结果。
 */
@Slf4j
@AllArgsConstructor
public class WebSearchExecutor implements ToolExecutor {
    private final WebSearchEngine webSearchEngine;
    private final ObjectMapper objectMapper;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            String args = toolExecution == null ? null : toolExecution.getArgs();
            // 校验顺序修正：先判空/判空白，再做 JSON 反序列化。
            // 原实现先 readValue(args) 后判空，args 为 null 时会被 Jackson 抢先抛出
            // MismatchedInputException("No content to map due to end-of-input")，
            // 错误信息与真实原因（参数缺失）完全对不上，误导模型排障。
            if (args == null || args.isBlank()) {
                return ToolExecuteResult.err("tool execute failed : args is empty");
            }
            WebSearchArguments arguments = objectMapper.readValue(args, WebSearchArguments.class);
            log.info("【ToolCall】 web_search :{}", args);
            String res = this.webSearchEngine.search(arguments);
            return ToolExecuteResult.success(res);
        } catch (Exception e) {
            return ToolExecuteResult.err("tool execute failed : " + e.getMessage());
        }
    }
}