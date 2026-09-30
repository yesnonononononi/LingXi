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
     * 产生这条消息的执行 ID（关联 {@code execution.id}）。
     *
     * <p>它是「回答分组」与「元信息归属」的唯一稳定键：前端按它把 USER / AI / TOOL / ERROR
     * 归到同一轮，并把 execution 摘要挂到组上。{@code null} 表示归属未知 —— 只出现在本次改造
     * 之前落库的旧数据上，展示层据此降级，**不按消息位置或时间戳猜测**。</p>
     */
    private final Long executionId;
    private final SessionMessageType type;
    private String text;
    private final Instant createTime;

}
