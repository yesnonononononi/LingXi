package com.summit.dp.shared.vo;

import lombok.Builder;
import lombok.Data;

import java.util.List;
import java.util.Map;

/** 会话消息游标分页结果。 */
@Data
@Builder
public class SessionMessagePageVO {
    private List<SessionMessageVO> records;
    private int toolCallCount;
    /** 下一页游标，为空表示已到末页 */
    private String nextCursor;
    private boolean hasMore;

    /**
     * 本页消息涉及的执行摘要，键为 {@code executionId} 字符串（雪花 ID 走字符串避免前端精度丢失）。
     *
     * <p><b>为什么随页下发而不是逐条挂：</b>同一执行会横跨多条消息（USER + 多轮 AI/TOOL），
     * 挂在消息上会重复传输同一份摘要；字典按 executionId 去重，且与消息列表解耦 ——
     * 前端按 executionId 分组时，组内任意一条消息都能查到同一份摘要。</p>
     *
     * <p>只包含**本页实际出现过的**执行，不做全量加载；摘要不含 {@code snapshot}。</p>
     */
    private Map<String, ExecutionSummaryVO> executions;
}
