package com.summit.dp.workflow.application.chat;

import com.summit.core.conversation.event.ExecutionErrorEvent;

import java.util.regex.Pattern;

/** 实时推送与轮次保存共用文案规则，避免刷新后又显示异常类名。 */
public final class ExecutionErrorText {
    private static final Pattern EXCEPTION_PREFIX = Pattern.compile(
            "^(?:(?:[\\p{javaJavaIdentifierStart}][\\p{javaJavaIdentifierPart}]*\\.)+"
                    + "[\\p{javaJavaIdentifierPart}]*(?:Exception|Error)(?::\\s*|$))+");

    private ExecutionErrorText() {
    }

    public static String resolve(ExecutionErrorEvent event) {
        String primary = stripExceptionPrefixes(event.getErrMsg());
        if (!primary.isEmpty()) return primary;
        String supplementary = stripExceptionPrefixes(event.getExtraDes());
        return supplementary.isEmpty() ? "执行异常" : supplementary;
    }

    private static String stripExceptionPrefixes(String text) {
        if (text == null) return "";
        // 只剥离开头的异常包装，正文中的冒号、路径和网址必须原样保留。
        return EXCEPTION_PREFIX.matcher(text.trim()).replaceFirst("").trim();
    }
}
