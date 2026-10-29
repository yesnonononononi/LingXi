package com.summit.dp.workflow.application.chat;

import com.summit.core.conversation.event.ExecutionErrorEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ExecutionErrorTextTest {
    @ParameterizedTest
    @CsvSource(delimiter = '|', value = {
            "dev.langchain4j.exception.TimeoutException: java.net.http.HttpTimeoutException: request timed out|request timed out",
            "java.util.concurrent.CompletionException: java.lang.RuntimeException: request timed out|request timed out",
            "java.io.IOException: Failed: https://example.test:8443|Failed: https://example.test:8443",
            "Service unavailable: retry at https://example.test:8443|Service unavailable: retry at https://example.test:8443",
            "无法访问 D:\\work\\file.txt: 拒绝访问|无法访问 D:\\work\\file.txt: 拒绝访问",
            "com.example.endpoint: unavailable|com.example.endpoint: unavailable",
            "执行失败: java.io.IOException: detail|执行失败: java.io.IOException: detail",
            "java.lang.IllegalStateException|执行异常"
    })
    void removesOnlyLeadingExceptionClasses(String original, String expected) {
        assertEquals(expected, ExecutionErrorText.resolve(new ExecutionErrorEvent(original, null, "1001")));
    }

    @Test
    void emptyPrimaryUsesTheCleanedSupplementaryMessage() {
        assertEquals("request timed out", ExecutionErrorText.resolve(new ExecutionErrorEvent(
                "java.lang.RuntimeException:", "java.net.http.HttpTimeoutException: request timed out", "1001")));
        assertEquals("执行异常", ExecutionErrorText.resolve(new ExecutionErrorEvent(null, "  ", "1001")));
    }
}
