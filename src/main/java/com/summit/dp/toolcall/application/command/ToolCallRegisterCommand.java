package com.summit.dp.toolcall.application.command;

import com.summit.dp.toolcall.domain.model.ToolCallKind;

/**
 * 登记一次 PROMISE 工具调用的入参（唯一登记器的输入）。
 *
 * @param toolCallId     模型下发的 call id（{@code tool_call.id}）
 * @param conversationId 所属会话（= {@code session.id}）
 * @param executionId    派生此次调用的执行 ID
 * @param toolName       原始工具名
 * @param kind           卡片形态判别（{@code PLAN}/{@code CHOICE}/{@code COMMAND}）
 * @param title          卡片标题
 * @param content        多态内容块 JSON（含 {@code kind}）
 * @param rawInput       输入载荷 JSON（{@code {"args":...}}）
 */
public record ToolCallRegisterCommand(
        String toolCallId,
        long conversationId,
        long executionId,
        String toolName,
        ToolCallKind kind,
        String title,
        String content,
        String rawInput
) {

    /** PROMISE 登记工厂（人工在环：计划 / 提问 / 命令审批）。 */
    public static ToolCallRegisterCommand promise(String toolCallId, long conversationId, long executionId,
                                                  String toolName, ToolCallKind kind, String title,
                                                  String content, String rawInput) {
        return new ToolCallRegisterCommand(toolCallId, conversationId, executionId, toolName, kind, title, content, rawInput);
    }
}
