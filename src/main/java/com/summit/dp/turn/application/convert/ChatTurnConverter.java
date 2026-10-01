package com.summit.dp.turn.application.convert;

import com.summit.dp.turn.application.vo.ChatTurnVO;
import com.summit.dp.turn.domain.model.ChatTurn;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;

/** 轮次领域模型 → 视图（纯转换，无持久化）。 */
@Component
public class ChatTurnConverter {

    /**
     * 转视图。
     *
     * @param now 本页统一的「查询时刻」基准。整页共用一个 now，避免同页不同行差几毫秒；
     *            进行中的轮次用它算「截至此刻的已历时」。
     */
    public ChatTurnVO toVO(ChatTurn turn, Instant now) {
        if (turn == null) {
            return null;
        }
        return ChatTurnVO.builder()
                .turnId(turn.getId())
                .parentTurnId(turn.getParentTurnId())
                .status(turn.getStatus() == null ? null : turn.getStatus().name())
                .modelName(turn.getModelName())
                .modelProvider(turn.getModelProvider())
                .inputTokens(turn.getInputTokenCount())
                .outputTokens(turn.getOutputTokenCount())
                .totalTokens(turn.getTotalTokenCount())
                .startedAt(turn.getStartedAt())
                .completedAt(turn.getCompletedAt())
                .errorReason(turn.getErrorReason())
                .elapsedMs(elapsedMillis(turn, now))
                .build();
    }

    /**
     * 已历时：首次开始 →（终态时间 或 查询时刻），**包含暂停与等待审批的时间**。
     *
     * <p>未开始（{@code startedAt} 为空）返回 {@code null}：没有开始时间就没有历时可言，
     * 返回 0 会被读成「瞬间完成」。</p>
     */
    private static Long elapsedMillis(ChatTurn turn, Instant now) {
        if (turn.getStartedAt() == null) {
            return null;
        }
        Instant end = turn.getCompletedAt() == null ? now : turn.getCompletedAt();
        return Math.max(Duration.between(turn.getStartedAt(), end).toMillis(), 0L);
    }
}
