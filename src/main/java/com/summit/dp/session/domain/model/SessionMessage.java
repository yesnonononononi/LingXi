package com.summit.dp.session.domain.model;



import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

@Builder
@Getter
public class SessionMessage {
    private final Long id;
    private final Long sessionId;
    /**
     * 这条消息所属的**业务轮次** ID（关联 {@code chat_turn.id}）。
     *
     * <p>它是「回答分组」与「元信息归属」的唯一键：前端按它把 USER / AI / TOOL / ERROR
     * 归到同一轮，并把轮次信息挂到组上。{@code null} 表示归属未知 —— 只出现在本次改造
     * 之前落库的旧数据上（或该执行没有对应轮次行），展示层据此降级，
     * **不按消息位置或时间戳猜测**。</p>
     *
     * <p><b>业务侧只有这一个归属概念</b>：框架执行 ID 仅存在于
     * {@code chat_turn.execution_id}（接收框架生命周期信号）与 {@code tool_call.execution_id}
     * （定位工具调用）这两个「与框架交互」的边界上，不进入消息归属。</p>
     */
    private final Long turnId;
    private final SessionMessageType type;
    private String text;
    private final Instant createTime;

}
