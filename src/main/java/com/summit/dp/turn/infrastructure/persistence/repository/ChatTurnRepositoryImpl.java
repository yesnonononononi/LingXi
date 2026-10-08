package com.summit.dp.turn.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.shared.exception.ClientException;
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
    public void save(ChatTurn turn) {
        super.save(turn);
    }

    /** 落库并保留根身份入参；协议渲染移除后该参数不再参与投递。 */
    @Override
    public void save(ChatTurn turn, Long rootSessionId) {
        super.save(turn);
    }

    @Override
    public void updateById(@NotNull ChatTurn turn) {
        mutate(turn);
    }

    /** 更新并保留根身份入参；协议渲染移除后该参数不再参与投递。 */
    @Override
    public void updateById(@NotNull ChatTurn turn, Long rootSessionId) {
        mutate(turn);
    }

    private void mutate(ChatTurn turn) {
        ChatTurnPO row = toPO(turn);
        long expected = turn.getVersion();
        row.setVersion(expected + 1);
        if (chatTurnMapper.update(row, Wrappers.<ChatTurnPO>lambdaUpdate()
                .eq(ChatTurnPO::getId, turn.getId()).eq(ChatTurnPO::getVersion, expected)) != 1) {
            throw new ClientException("轮次状态已变化，请刷新后重试");
        }
        turn.acceptPersistedVersion(expected + 1);
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
        return chatTurnMapper.markOrphansFailed(ChatTurnStatus.FAILED.name(),
                ChatTurnStatus.ACCEPTED.name(), ChatTurnStatus.RUNNING.name(), completedAt);
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

    /**
     * 按主键倒序取一页轮次。
     *
     * <p>与 {@link #findFromId} 同为「按主键切轮次」，只是方向相反、带上限：
     * 历史首屏取最新的一页，向上翻页取更早的一页。雪花主键单调递增，
     * {@code id < cursorTurnId} 恒等价于「更早的一轮」。</p>
     */
    @Override
    public List<ChatTurn> findLatest(Long sessionId, Long cursorTurnId, int limit) {
        if (sessionId == null) {
            return List.of();
        }
        LambdaQueryWrapper<ChatTurnPO> wrapper = Wrappers.<ChatTurnPO>lambdaQuery()
                .eq(ChatTurnPO::getSessionId, sessionId);
        if (cursorTurnId != null) {
            wrapper.lt(ChatTurnPO::getId, cursorTurnId);
        }
        return chatTurnMapper.selectList(wrapper.orderByDesc(ChatTurnPO::getId)
                        .last("LIMIT " + Math.max(limit, 1)))
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
