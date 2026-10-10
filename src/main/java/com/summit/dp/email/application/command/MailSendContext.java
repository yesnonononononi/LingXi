package com.summit.dp.email.application.command;

/**
 * 发信的执行上下文：由调用方从<b>受控来源</b>解析后传入，模型无法指定。
 *
 * <p>发信工具只接收 {@code toAgentId} 与 {@code mailContent}；发送者、协作根会话与团队快照
 * 一律由服务端从当前工具执行 / 循环上下文的受控属性解析，避免调用方（尤其是模型）
 * 伪造路由字段。</p>
 *
 * @param workflowExecutionId 本次协作的根会话 ID（根执行取自身会话，子执行取 {@code ROOT_SESSION_ID}）；列名保持历史命名，语义已是根会话
 * @param senderAgentId       发件 Agent ID（来自当前执行的 {@code lingxi.agent_id} 属性）
 * @param teamId              本次协作轮次的团队 ID 快照；非团队会话为 null
 */
public record MailSendContext(Long workflowExecutionId, Long senderAgentId, Long teamId) {
}
