package com.summit.dp.workflow.application.chat;

import com.summit.core.conversation.event.ExecutionErrorEvent;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ExecutionErrorTextTest {
    @ParameterizedTest
    @ValueSource(strings = {
            "{\"error\":{\"message\":\"Invalid 'Authorization' header or token.\",\"type\":\"authentication_error\",\"code\":\"UNAUTHORIZED\"}}",
            "com.summit.core.exception.NonRetriableModelException: {\"error\":{\"code\":\"UNAUTHORIZED\"}}",
            "{\"error\":{\"code\":\"invalid_api_key\"}}",
            "{\"error\":{\"type\":\"authentication_error\"}}"
    })
    void authenticationErrorsExplainHowToRepairTheModelCredential(String original) {
        String expected = "模型服务认证失败，请在模型设置中更新有效 API Key 后重试；使用提供商密钥的模型需重新应用该密钥。";
        assertEquals(expected, ExecutionErrorText.resolve(new ExecutionErrorEvent(original, null, "1001")));
        assertEquals(expected, ExecutionErrorText.resolve(new ExecutionErrorEvent(null, original, "1001")));
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "{\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"Too many requests\"}}",
            "{\"message\":\"示例中包含 UNAUTHORIZED\"}",
            "{\"error\":{\"code\":\"UNAUTHORIZED\""
    })
    void otherOrMalformedErrorsKeepTheirActualMeaning(String original) {
        assertEquals(original, ExecutionErrorText.resolve(new ExecutionErrorEvent(original, null, "1001")));
    }

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
