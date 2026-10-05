package com.summit.dp.stream.application.service;

import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 快照该收哪些轮次。
 *
 * <p><b>规则</b>：两类必须收 ——
 * <b>未完成</b>的轮次（含状态未知的脏数据，否则脏轮次会从快照里消失、用户看到「凭空少了一轮」），
 * 以及<b>执行仍在跑</b>的已完成轮次（工具结果还会回填，提前丢弃会让用户看到空的工具区）。
 * 除此之外只保留最近 {@link StreamSnapshotAssembler#RETAINED_COMPLETED_TURNS} 个已完成轮次。</p>
 *
 * <p>抽出来是因为这段规则和后面的消息筛选共用同一个 {@code retained} 集合，
 * 放在装配 lambda 里会让「谁决定保留」这件事只能顺着读代码才看得清。</p>
 */
@Component
@RequiredArgsConstructor
public class TurnRetainResolver {

    private final ChatTurnRepository turns;
    private final ExecutionRepository executions;

    /** 全量轮次中该纳入快照的轮次 id（保持 {@code allTurns} 的原始顺序）。 */
    public Set<Long> resolveRetained(List<ChatTurn> allTurns, Set<Long> unfinishedIds) {
        Set<Long> retained = new LinkedHashSet<>();
        allTurns.stream()
                .filter(turn -> turn.getStatus() == null || !turn.getStatus().isTerminal()
                        || unfinishedIds.contains(turn.getExecutionId()))
                .map(ChatTurn::getId).forEach(retained::add);
        allTurns.stream().sorted(Comparator.comparing(ChatTurn::getId).reversed())
                .filter(turn -> turn.getStatus() != null && turn.getStatus().isTerminal())
                .limit(StreamSnapshotAssembler.RETAINED_COMPLETED_TURNS)
                .map(ChatTurn::getId).forEach(retained::add);
        return retained;
    }

    /** 会话树里全部轮次，按会话顺序平铺。 */
    public List<ChatTurn> loadAllTurns(List<Session> tree) {
        return tree.stream().flatMap(session -> turns.findFromId(session.getId(), 0L).stream()).toList();
    }

    /** 这些会话下仍在生命周期内的执行 id：它们的轮次即便已标完成也必须保留。 */
    public Set<Long> resolveUnfinishedExecutions(List<Long> sessionIds) {
        Set<Long> unfinishedIds = new LinkedHashSet<>();
        executions.findUnfinishedBySessions(sessionIds).stream()
                .map(Execution::getId).forEach(unfinishedIds::add);
        return unfinishedIds;
    }
}