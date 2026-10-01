package com.summit.dp.turn.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** chat_turn 仓储实现。 */
@Repository
@RequiredArgsConstructor
public class ChatTurnRepositoryImpl extends AbstractRepository<ChatTurn, ChatTurnPO, Long>
        implements ChatTurnRepository {

    private final ChatTurnMapper chatTurnMapper;

    @Override
    public Optional<ChatTurn> findByExecutionId(Long executionId) {
        if (executionId == null) {
            return Optional.empty();
        }
        ChatTurnPO po = chatTurnMapper.selectOne(Wrappers.<ChatTurnPO>lambdaQuery()
                .eq(ChatTurnPO::getExecutionId, executionId));
        return po == null ? Optional.empty() : Optional.of(toModel(po));
    }

    @Override
    public List<ChatTurn> findByExecutionIds(Collection<Long> executionIds) {
        if (executionIds == null || executionIds.isEmpty()) {
            return List.of();
        }
        LambdaQueryWrapper<ChatTurnPO> wrapper = Wrappers.<ChatTurnPO>lambdaQuery()
                .in(ChatTurnPO::getExecutionId, executionIds);
        return chatTurnMapper.selectList(wrapper).stream().map(this::toModel).toList();
    }

    @Override
    public List<ChatTurn> findByIds(Collection<Long> turnIds) {
        if (turnIds == null || turnIds.isEmpty()) {
            return List.of();
        }
        return chatTurnMapper.selectByIds(turnIds).stream().map(this::toModel).toList();
    }

    @Override
    public int markOrphansFailed(Instant completedAt) {
        return chatTurnMapper.markOrphansFailed(ChatTurnStatus.FAILED.name(),
                ChatTurnStatus.ACCEPTED.name(), ChatTurnStatus.RUNNING.name(), completedAt);
    }

    @Override
    protected ChatTurnPO toPO(ChatTurn turn) {
        return ChatTurnPO.builder()
                .id(turn.getId())
                .sessionId(turn.getSessionId())
                .parentTurnId(turn.getParentTurnId())
                .executionId(turn.getExecutionId())
                .status(turn.getStatus() == null ? null : turn.getStatus().name())
                .modelName(turn.getModelName())
                .modelProvider(turn.getModelProvider())
                .inputTokenCount(turn.getInputTokenCount())
                .outputTokenCount(turn.getOutputTokenCount())
                .totalTokenCount(turn.getTotalTokenCount())
                .startedAt(turn.getStartedAt())
                .completedAt(turn.getCompletedAt())
                .errorReason(turn.getErrorReason())
                .createdAt(turn.getCreatedAt())
                .updatedAt(turn.getUpdatedAt())
                .build();
    }

    @Override
    protected ChatTurn toModel(ChatTurnPO po) {
        return ChatTurn.builder()
                .id(po.getId())
                .sessionId(po.getSessionId())
                .parentTurnId(po.getParentTurnId())
                .executionId(po.getExecutionId())
                // 状态列是自由文本；非法值解析为 null，由展示层降级，绝不在这里抛异常把读取打挂。
                .status(ChatTurnStatus.of(po.getStatus()))
                .modelName(po.getModelName())
                .modelProvider(po.getModelProvider())
                .inputTokenCount(po.getInputTokenCount())
                .outputTokenCount(po.getOutputTokenCount())
                .totalTokenCount(po.getTotalTokenCount())
                .startedAt(po.getStartedAt())
                .completedAt(po.getCompletedAt())
                .errorReason(po.getErrorReason())
                .createdAt(po.getCreatedAt())
                .updatedAt(po.getUpdatedAt())
                .build();
    }

    @Override
    protected @NotNull BaseMapper<ChatTurnPO> mapper() {
        return chatTurnMapper;
    }
}
