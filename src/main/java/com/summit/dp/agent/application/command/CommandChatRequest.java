package com.summit.dp.agent.application.command;

import com.summit.dp.shared.utils.CommandDigest;

import java.util.Objects;

/**
 * 带命令身份的聊天请求：v2 受理入口的入参。
 *
 * <p><b>命令身份与业务参数分离</b>：{@code commandId} 只表达「同一次用户意图的重试身份」，
 * 不参与模型解析；把它塞进 {@link ChatCommand} 会让 v1 的 SSE 入口也背上它，
 * 而 v1 没有幂等语义，凭空多一个字段只会诱使后来者误以为两条入口共享同一套幂等。</p>
 *
 * @param command    业务参数（与 v1 完全相同的解析口径）
 * @param commandId  命令受理身份；为空表示本次不参与命令幂等（v2 入口要求非空）
 */
public record CommandChatRequest(ChatCommand command, String commandId) {

    public CommandChatRequest {
        Objects.requireNonNull(command, "command");
    }

    /**
     * 本次命令的请求摘要。
     *
     * <p><b>只覆盖真正决定这一轮内容的字段</b>：{@code messageId} 参与，因为重发靠它定位
     * 被改写的那条提问 —— 同一 commandId 换了 checkpoint 就是在改写另一条历史。
     * 图片按「文件名 + 字节数 + 内容摘要」而非整段 base64 参与，避免大图把摘要算成几十 MB。</p>
     */
    public String buildDigest() {
        return CommandDigest.build(
                command.sessionId(),
                command.input(),
                command.modelId(),
                command.workspaceId(),
                command.messageId(),
                command.agentId(),
                Boolean.toString(command.requirePlan()),
                CommandDigest.describeImage(command.imageFile()),
                command.imageUrl());
    }
}
