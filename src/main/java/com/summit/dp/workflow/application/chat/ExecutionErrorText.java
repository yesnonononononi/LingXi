package com.summit.dp.workflow.application.chat;

import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.regex.Pattern;

/** 实时推送与轮次保存共用文案规则，避免刷新后又显示异常类名。 */
public final class ExecutionErrorText {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Pattern EXCEPTION_PREFIX = Pattern.compile(
            "^(?:(?:[\\p{javaJavaIdentifierStart}][\\p{javaJavaIdentifierPart}]*\\.)+"
                    + "[\\p{javaJavaIdentifierPart}]*(?:Exception|Error)(?::\\s*|$))+");

    private ExecutionErrorText() {
    }

    public static String resolve(ExecutionErrorEvent event) {
        String primary = normalizeMessage(event.getErrMsg());
        if (!primary.isEmpty()) return primary;
        String supplementary = normalizeMessage(event.getExtraDes());
        return supplementary.isEmpty() ? "执行异常" : supplementary;
    }

    private static String normalizeMessage(String text) {
        if (text == null) return "";
        // 只剥离开头的异常包装，正文中的冒号、路径和网址必须原样保留。
        String message = EXCEPTION_PREFIX.matcher(text.trim()).replaceFirst("").trim();
        if (!message.startsWith("{")) return message;
        try {
            JsonNode body = JSON.readTree(message);
            JsonNode error = body.path("error");
            String code = error.path("code").asText();
            String type = error.path("type").asText();
            // 只认结构化认证错误，普通正文提到错误码时不能误判。
            if ("authentication_error".equalsIgnoreCase(type) || "UNAUTHORIZED".equalsIgnoreCase(code)
                    || "invalid_api_key".equalsIgnoreCase(code)) {
                return "模型服务认证失败，请在模型设置中更新有效 API Key 后重试；使用提供商密钥的模型需重新应用该密钥。";
            }
        } catch (JsonProcessingException ignored) {
            // 不完整或非标准响应保留原文，不能把解析失败覆盖成另一种执行错误。
        }
        return message;
    }
}
