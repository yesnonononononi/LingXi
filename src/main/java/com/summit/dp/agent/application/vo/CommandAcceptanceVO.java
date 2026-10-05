package com.summit.dp.agent.application.vo;

/**
 * v2 受理回执：只绑定命令与用户消息身份，不负责新建 assistant 副本。
 *
 * <p><b>为什么回执里没有 assistant 消息</b>：运行时通知可能先于 HTTP 回执到达 ——
 * 极快的模型回复已经在流里推给前端了。若回执再带一份 assistant 副本，前端就会渲染出两个气泡。
 * 回执的职责是「你的命令被受理成了哪一轮」，回复内容一律走事件流与历史回查。</p>
 *
 * @param sessionId   会话 id
 * @param turnId      本轮业务轮次 id
 * @param executionId 框架执行 id；受理时已知（执行身份在 prepare 阶段固化），故一般非空
 * @param commandId   命令受理身份
 * @param acceptance  受理状态：首次受理 or 同命令查回
 */
public record CommandAcceptanceVO(
        Long sessionId,
        Long turnId,
        String executionId,
        String commandId,
        CommandAcceptance acceptance
) {
}
