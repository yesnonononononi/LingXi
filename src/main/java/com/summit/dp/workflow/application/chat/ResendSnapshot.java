package com.summit.dp.workflow.application.chat;

import java.util.List;

/**
 * 重发要复现的上下文规格：目标轮次当时的系统提示词与记忆段。
 *
 * <p>为什么必须逐字复用：这两段是前缀缓存的锚点。按「现在」重建会把新记忆段接在旧历史之后，
 * 旧历史里的动态上下文块与它对不上，框架判定动态段被改写，缓存从该点整段作废。</p>
 *
 * <p>只带这两段、不带消息列表：本轮消息由 {@code ResendTarget.baseline()} 截断后接上新提问，
 * 旧消息列表整段照搬会把被改写的那条提问也带回来。</p>
 *
 * @param systemPrompt 目标轮次的系统提示词
 * @param memory       目标轮次的记忆段，按原有顺序
 */
public record ResendSnapshot(String systemPrompt, List<String> memory) {

    public ResendSnapshot {
        memory = memory == null ? List.of() : List.copyOf(memory);
    }
}
