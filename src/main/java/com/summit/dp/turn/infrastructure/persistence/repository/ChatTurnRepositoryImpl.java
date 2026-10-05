package com.summit.dp.turn.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.event.CommittedStatePublisher;
import com.summit.dp.shared.event.CommittedStateChange;
import org.springframework.beans.factory.annotation.Autowired;
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
    @Autowired(required = false)
    private CommittedStatePublisher statePublisher;

    @Override
    public void save(ChatTurn turn) {
        super.save(turn);
        publishCommitted(turn, null);
    }

    /**
     * 落库并随通知带上根身份与已提交事实（含终值 version）。
     *
     * <p>{@code rootSessionId} 是 v3 投递目标，{@code turn.getSessionId()} 是实体归属。
     * 子会话轮次必须由调用方传入根，否则投进子会话桶而无人接收。</p>
     */
    @Override
    public void save(ChatTurn turn, Long rootSessionId) {
        super.save(turn);
        publishCommitted(turn, rootSessionId);
    }

    @Override
    public void updateById(@NotNull ChatTurn turn) {
        mutate(turn, null);
    }

    /** 更新并发布落库终值；根身份语义同 {@link #save(ChatTurn, Long)}。 */
    @Override
    public void updateById(@NotNull ChatTurn turn, Long rootSessionId) {
        mutate(turn, rootSessionId);
    }

    private void mutate(ChatTurn turn, Long rootSessionId) {
        ChatTurnPO row = toPO(turn);
        long expected = turn.getVersion();
        row.setVersion(expected + 1);
        if (chatTurnMapper.update(row, Wrappers.<ChatTurnPO>lambdaUpdate()
                .eq(ChatTurnPO::getId, turn.getId()).eq(ChatTurnPO::getVersion, expected)) != 1) {
            throw new ClientException("轮次状态已变化，请刷新后重试");
        }
        turn.acceptPersistedVersion(expected + 1);
        // acceptPersistedVersion 之后才发布：通知里带的是落库终值，不是提交前的旧版本。
        publishCommitted(turn, rootSessionId);
    }

    private void publishCommitted(ChatTurn turn, Long rootSessionId) {
        if (statePublisher == null) return;
        statePublisher.publish(CommittedStateChange.of(
                CommittedStateChange.Kind.TURN, rootSessionId, turn.getSessionId(), turn.getId(), turn));
    }

    @Override
    public void update(Collection<ChatTurn> turns) { turns.forEach(this::updateById); }

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
    public Optional<ChatTurn> findByCommandId(String commandId) {
        if (commandId == null || commandId.isBlank()) {
            return Optional.empty();
        }
        ChatTurnPO po = chatTurnMapper.selectOne(Wrappers.<ChatTurnPO>lambdaQuery()
                .eq(ChatTurnPO::getCommandId, commandId.trim()));
        return po == null ? Optional.empty() : Optional.of(toModel(po));
    }

    @Override
    public List<ChatTurn> findByExecutionIds(Collection<Long> executionIds) {        if (executionIds == null || executionIds.isEmpty()) {
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

    /**
     * 按会话集合批量取进行中轮次；一次 IN 查询，状态条件走 {@code IN}，不逐会话查。
     *
     * <p>进行中 = ACCEPTED / RUNNING / WAITING（WAITING 对应框架 SUSPENDED，可恢复，
     * 与 {@link #markOrphansFailed} 排除 WAITING 的口径一致）。</p>
     */
    @Override
    public List<ChatTurn> findActiveBySessionIds(Collection<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return List.of();
        }
        return chatTurnMapper.selectList(Wrappers.<ChatTurnPO>lambdaQuery()
                        .in(ChatTurnPO::getSessionId, sessionIds)
                        .in(ChatTurnPO::getStatus,
                                ChatTurnStatus.ACCEPTED.name(),
                                ChatTurnStatus.RUNNING.name(),
                                ChatTurnStatus.WAITING.name())
                        .orderByAsc(ChatTurnPO::getId))
                .stream().map(this::toModel).toList();
    }

    @Override
    public int markOrphansFailed(Instant completedAt) {
        List<ChatTurnPO> affected = chatTurnMapper.selectList(Wrappers.<ChatTurnPO>lambdaQuery()
                .select(ChatTurnPO::getId, ChatTurnPO::getSessionId)
                .in(ChatTurnPO::getStatus, ChatTurnStatus.ACCEPTED.name(), ChatTurnStatus.RUNNING.name()));
        int count = chatTurnMapper.markOrphansFailed(ChatTurnStatus.FAILED.name(),
                ChatTurnStatus.ACCEPTED.name(), ChatTurnStatus.RUNNING.name(), completedAt);
        if (count > 0 && statePublisher != null) affected.forEach(row -> statePublisher.publish(
                CommittedStateChange.entity(CommittedStateChange.Kind.TURN, row.getSessionId(), row.getId())));
        return count;
    }

    @Override
    public List<ChatTurn> findFromId(Long sessionId, Long fromTurnId) {
        if (sessionId == null || fromTurnId == null) {
            return List.of();
        }
        return chatTurnMapper.selectList(Wrappers.<ChatTurnPO>lambdaQuery()
                        .eq(ChatTurnPO::getSessionId, sessionId)
                        .ge(ChatTurnPO::getId, fromTurnId)
                        .orderByAsc(ChatTurnPO::getId))
                .stream().map(this::toModel).toList();
    }

    @Override
    public int deleteFromId(Long sessionId, Long fromTurnId) {
        if (sessionId == null || fromTurnId == null) {
            return 0;
        }
        return chatTurnMapper.delete(Wrappers.<ChatTurnPO>lambdaQuery()
                .eq(ChatTurnPO::getSessionId, sessionId)
                .ge(ChatTurnPO::getId, fromTurnId));
    }

    @Override
    protected ChatTurnPO toPO(ChatTurn turn) {
        return ChatTurnPO.builder()
                .id(turn.getId())
                .version(turn.getVersion())
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
                .version(po.getVersion() == null ? 1L : po.getVersion())
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
                .commandId(po.getCommandId())
                .commandDigest(po.getCommandDigest())
                .createdAt(po.getCreatedAt())
                .updatedAt(po.getUpdatedAt())
                .build();
    }

    @Override
    protected @NotNull BaseMapper<ChatTurnPO> mapper() {
        return chatTurnMapper;
    }
}
