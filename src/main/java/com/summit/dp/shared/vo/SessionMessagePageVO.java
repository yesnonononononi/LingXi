package com.summit.dp.shared.vo;

import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.turn.application.vo.ChatTurnVO;
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
    private Long historyRevision;
    private String messageCursor;


    /**
     * 本页消息涉及的业务轮次，键为 {@code turnId} 字符串（雪花 ID 走字符串避免前端精度丢失）。
     *
     * <p><b>为什么随页下发而不是逐条挂：</b>同一轮次会横跨多条消息（USER + 多轮 AI/TOOL），
     * 挂在消息上会重复传输同一份信息；字典按 turnId 去重，且与消息列表解耦 ——
     * 前端按 turnId 分组时，组内任意一条消息都能查到同一份轮次信息。</p>
     *
     * <p>数据源是业务自己的 {@code chat_turn} 表（业务上最权威的单次请求记录），
     * 一次 IN 批量装载，不做 N+1。只包含本页实际出现过的轮次；本次改造之前的旧消息
     * 没有对应轮次，因此可能为空。</p>
     */
    private Map<String, ChatTurnVO> turns;

    /**
     * 本页轮次的 Block 视图，键为 {@code turnId} 字符串。
     *
     * <p><b>与 {@link #turns} 的关系</b>：{@code turns} 只给轮次的元信息（状态 / 用量 / 历时），
     * {@code turnViews} 给该轮的**展示内容与顺序**（块列表）。历史与实时共用同一份
     * {@link TurnViewVO} 形状，前端因此只需一套「按 blockId 更新」的对账逻辑。</p>
     *
     * <p>分页单位是完整轮次，所以这里每个 turnId 恒是完整的一轮，不会出现「半轮」。</p>
     */
    private Map<String, TurnViewVO> turnViews;
}
