package com.summit.dp.shared.vo.block;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.summit.core.compact.ContextUsageMetric;

import java.util.List;

/**
 * 一轮的展示视图 —— 历史查询与 SSE 共用的**唯一契约形状**。
 *
 * <p><b>归属与路由分开</b>：{@code sessionId} / {@code turnId} 是块内容的**真实归属**
 * （子会话就是子会话自己的 id）；SSE 的 {@code rootSessionId} 只用于**传输路由**，
 * 不进入本 VO —— 把它当归属键会因子会话、以及根会话「哨兵 0」而错位。</p>
 *
 * <p><b>只有一个对外版本号 {@code viewVersion}</b>：语义是「该 turn 展示的更新批次号」，
 * 每次后端重建/更新该轮视图就递增。历史查询与 SSE 共用它；前端拿到更小的批次号应丢弃
 * （乱序到达的旧帧）。⚠️ 后端重建视图时**建立新基线并作废旧请求**，
 * 因此**不能拿重建前后的编号直接比较**。</p>
 *
 * <p>{@code chat_turn.version} 是数据库乐观锁，属**内部**实现，**不对外** ——
 * 它随每次落库自增，与「展示更新批次」不是同一件事。</p>
 */
public record TurnViewVO(
        @JsonProperty("sessionId") Long sessionId,
        @JsonProperty("turnId") Long turnId,
        @JsonProperty("status") String status,
        @JsonProperty("viewVersion") long viewVersion,
        @JsonProperty("userMessage") String userMessage,
        @JsonProperty("userImageUrls") List<String> userImageUrls,
        @JsonProperty("blocks") List<Block> blocks,
        @JsonProperty("metric") ContextUsageMetric metric
) {
    public TurnViewVO {
        userImageUrls = userImageUrls == null ? List.of() : List.copyOf(userImageUrls);
        blocks = blocks == null ? List.of() : List.copyOf(blocks);
    }
}
