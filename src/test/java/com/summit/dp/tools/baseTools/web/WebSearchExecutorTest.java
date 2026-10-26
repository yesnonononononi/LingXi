package com.summit.dp.tools.baseTools.web;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.arguments.WebSearchArguments;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchEngine;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchExecutor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * {@link WebSearchExecutor} 的参数校验顺序测试。
 *
 * <p>修复点：原实现先 {@code objectMapper.readValue(args, ...)} 再判空，args 为 null 时
 * Jackson 抢先抛 "No content to map due to end-of-input"，错误信息与真实原因（参数缺失）不符，
 * 误导模型排障。现在 null / blank 判断前置，必须直接返回 "args is empty" 且不触碰引擎。</p>
 */
class WebSearchExecutorTest {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private static ToolExecution executionWithArgs(String args) {
        return ToolExecution.builder().args(args).build();
    }

    @Test
    @DisplayName("args 为 null 时直接报 args is empty，且不调用引擎")
    void nullArgsIsRejectedBeforeDeserialization() {
        WebSearchEngine engine = mock(WebSearchEngine.class);
        WebSearchExecutor executor = new WebSearchExecutor(engine, OBJECT_MAPPER);

        ToolExecuteResult result = executor.execute(executionWithArgs(null));

        assertNotNull(result);
        assertFalse(result.isSuccess());
        assertNotNull(result.getToolOutput());
        assertTrue(result.getToolOutput().contains("args is empty"), result.getToolOutput());
        verifyNoInteractions(engine);
    }

    @Test
    @DisplayName("args 为空白串时直接报 args is empty，且不调用引擎")
    void blankArgsIsRejectedBeforeDeserialization() {
        WebSearchEngine engine = mock(WebSearchEngine.class);
        WebSearchExecutor executor = new WebSearchExecutor(engine, OBJECT_MAPPER);

        ToolExecuteResult result = executor.execute(executionWithArgs("   "));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("args is empty"), result.getToolOutput());
        verifyNoInteractions(engine);
    }

    @Test
    @DisplayName("合法 args 正常透传到引擎并返回成功结果")
    void validArgsIsForwardedToEngine() throws Exception {
        WebSearchEngine engine = mock(WebSearchEngine.class);
        when(engine.search(any(WebSearchArguments.class))).thenReturn("RESULT");
        WebSearchExecutor executor = new WebSearchExecutor(engine, OBJECT_MAPPER);

        ToolExecuteResult result = executor.execute(executionWithArgs("{\"query\":\"lingxi\"}"));

        assertTrue(result.isSuccess());
        assertEquals("RESULT", result.getToolOutput());
    }

    @Test
    @DisplayName("非法 JSON 报解析错误，而不是 args is empty")
    void invalidJsonReportsParseError() {
        WebSearchEngine engine = mock(WebSearchEngine.class);
        WebSearchExecutor executor = new WebSearchExecutor(engine, OBJECT_MAPPER);

        ToolExecuteResult result = executor.execute(executionWithArgs("{not-json"));

        assertFalse(result.isSuccess());
        assertNotNull(result.getToolOutput());
        assertFalse(result.getToolOutput().contains("args is empty"), result.getToolOutput());
    }

    @Test
    @DisplayName("toolExecution 为 null 时报 args is empty，且不调用引擎")
    void nullToolExecutionIsRejected() {
        WebSearchEngine engine = mock(WebSearchEngine.class);
        WebSearchExecutor executor = new WebSearchExecutor(engine, OBJECT_MAPPER);

        ToolExecuteResult result = executor.execute(null);

        assertNotNull(result);
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("args is empty"), result.getToolOutput());
        verifyNoInteractions(engine);
    }

    @Test
    @DisplayName("引擎抛异常时被收敛为失败结果并保留原因，不向调用方抛出")
    void engineExceptionIsConvertedToErrorResult() throws Exception {
        WebSearchEngine engine = mock(WebSearchEngine.class);
        when(engine.search(any(WebSearchArguments.class))).thenThrow(new java.io.IOException("connect timeout"));
        WebSearchExecutor executor = new WebSearchExecutor(engine, OBJECT_MAPPER);

        ToolExecuteResult result = executor.execute(executionWithArgs("{\"query\":\"lingxi\"}"));

        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("tool execute failed"), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("connect timeout"), result.getToolOutput());
    }
}