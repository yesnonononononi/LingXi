package com.summit.dp.toolcall.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.toolcall.infrastructure.persistence.VersionedUpdate;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO;
import com.summit.dp.shared.event.CommittedStatePublisher;
import com.summit.dp.shared.event.CommittedStateChange;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.stream.Collectors;

/** 状态由领域方法推进，持久化按版本条件更新，避免旧决策覆盖新锚点。 */
@Repository
@RequiredArgsConstructor
public class ToolCallRepositoryImpl
        extends AbstractRepository<ToolCall, ToolCallPO, String>
        implements ToolCallRepository {

    @Autowired(required = false)
    private CommittedStatePublisher statePublisher;

    private final ToolCallMapper toolCallMapper;
    private final ObjectMapper contentMapper;
    private final CardAvailabilityPolicy cardAvailability;

    @Override
    public void save(ToolCall tool) {
        super.save(tool);
        publishAfterCommit(tool);
    }

    /**
     * 状态变更通知走事务提交后。
     *
     * <p><b>为什么不能提交前发</b>：订阅者收到通知后会立刻回查投影，而查询可能落到另一个
     * 连接上，读不到尚未提交的行 —— 表现为「收到更新事件，刷新却还是旧状态」。
     * 对齐 {@code LocalExecutionRepository} 的 {@code cacheAfterCommit} 口径。</p>
     */
    private void publishAfterCommit(ToolCall tool) {
        if (statePublisher == null) return;
        Runnable publish = () -> statePublisher.publish(CommittedStateChange.entity(
                CommittedStateChange.Kind.TOOL, tool.getConversationId(), tool.getId()));
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            publish.run();
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { publish.run(); }
        });
    }

    @Override
    public List<Long> listUnresolvedExecutionIds() {
        return toolCallMapper.selectList(unresolved()
                .select(ToolCallPO::getExecutionId)
                .isNotNull(ToolCallPO::getExecutionId))
                .stream().map(ToolCallPO::getExecutionId).distinct().toList();
    }

    /**
     * 「未决槽位」的查询谓词：PROMISE 且状态 ∈ {准备中, 待决, 执行中}。
     *
     * <p>两个查询共用同一谓词；此前各写一遍，加状态时漏改一处就会让「恢复闸门」与
     * 「重登检查」对同一批槽位给出不同答案。</p>
     */
    private LambdaQueryWrapper<ToolCallPO> unresolved() {
        return Wrappers.<ToolCallPO>lambdaQuery()
                .eq(ToolCallPO::getType, ToolCallType.PROMISE.name())
                .in(ToolCallPO::getStatus, ToolCallStatus.PREPARING.dbValue(),
                        ToolCallStatus.PENDING.dbValue(), ToolCallStatus.IN_PROGRESS.dbValue());
    }

    /**
     * 可提交人工决策的未决槽位。
     *
     * <p>形态判定委托 {@link CardAvailabilityPolicy}，与卡片按钮的可用性口径同源 ——
     * 两边各判一次时，改了其中一边的形态清单就会出「按钮亮着但点了报错」。</p>
     */
    @Override
    public List<ToolCall> listActionableByExecutionId(Long executionId) {
        return listPendingByExecutionId(executionId).stream()
                .filter(ToolCall::isApprovalPending).filter(this::isHumanInteraction).toList();
    }

    private boolean isHumanInteraction(ToolCall call) {
        try {
            JsonNode content = contentMapper.readTree(call.getContent());
            ToolCallKind kind = content == null ? null : ToolCallKind.fromName(content.path(ToolCallKeys.KIND).asText());
            return cardAvailability.isHumanDecision(kind);
        } catch (Exception error) {
            return false;
        }
    }

    @Override
    public void updateById(@NotNull ToolCall model) {
        ToolCallPO update = toPO(model);
        long expectedVersion = model.getVersion();
        update.setVersion(VersionedUpdate.nextVersion(expectedVersion));
        int changed = toolCallMapper.update(update, Wrappers.<ToolCallPO>lambdaUpdate()
                .eq(ToolCallPO::getId, model.getId())
                .eq(ToolCallPO::getVersion, expectedVersion));
        VersionedUpdate.requireSingleRow(changed);
        model.acceptPersistedVersion(expectedVersion + 1);
        publishAfterCommit(model);
    }

    @Override
    public void update(Collection<ToolCall> models) {
        if (models != null) models.forEach(this::updateById);
    }

    @Override
    public List<ToolCall> listUnresolvedByExecutionId(Long executionId) {
        if (executionId == null) return List.of();
        return orderByCreatedAt(unresolved().eq(ToolCallPO::getExecutionId, executionId));
    }

    @Override
    public List<ToolCall> listByIds(Collection<String> ids) {
        if (ids == null || ids.isEmpty()) return List.of();
        // 不按状态过滤：这里的唯一调用方是消息分页装配（SessionMessageQueryService），
        // 它要的是「这一页 TOOL 行对应的全部调用」——完成态的结果与结论也要下发，
        // 否则前端历史里所有已完成工具都只剩「状态未知」。待决集合另有 listPendingBy* 两个入口。
        return toolCallMapper.selectList(new LambdaQueryWrapper<ToolCallPO>()
                .in(ToolCallPO::getId, ids)
                .orderByAsc(ToolCallPO::getId)
        ).stream().map(this::toModel).collect(Collectors.toCollection(ArrayList::new));
    }

    @Override
    public List<ToolCall> listByConversationId(Long conversationId) {
        if (conversationId == null) return List.of();
        return orderByCreatedAt(Wrappers.<ToolCallPO>lambdaQuery()
                .eq(ToolCallPO::getConversationId, conversationId));
    }

    @Override
    public List<ToolCall> listByExecutionId(Long executionId) {
        if (executionId == null) return List.of();
        return orderByCreatedAt(Wrappers.<ToolCallPO>lambdaQuery()
                .eq(ToolCallPO::getExecutionId, executionId));
    }

    @Override
    public List<ToolCall> listPendingByExecutionId(Long executionId) {
        if (executionId == null) return List.of();
        return orderByCreatedAt(Wrappers.<ToolCallPO>lambdaQuery()
                .eq(ToolCallPO::getExecutionId, executionId)
                .eq(ToolCallPO::getStatus, ToolCallStatus.PENDING.dbValue()));
    }

    @Override
    public List<ToolCall> listPendingByConversationId(Long conversationId) {
        if (conversationId == null) return List.of();
        return orderByCreatedAt(Wrappers.<ToolCallPO>lambdaQuery()
                .eq(ToolCallPO::getConversationId, conversationId)
                .eq(ToolCallPO::getStatus, ToolCallStatus.PENDING.dbValue()));
    }

    @Override
    public boolean existsById(String id) {
        return id != null && toolCallMapper.selectById(id) != null;
    }

    @Override
    public long countByConversationId(Long conversationId) {
        if (conversationId == null) return 0L;
        return toolCallMapper.selectCount(Wrappers.<ToolCallPO>lambdaQuery()
                .eq(ToolCallPO::getConversationId, conversationId));
    }

    @Override
    public int deleteByConversationIds(Collection<Long> conversationIds) {
        if (conversationIds == null || conversationIds.isEmpty()) return 0;
        return toolCallMapper.delete(Wrappers.<ToolCallPO>lambdaQuery()
                .in(ToolCallPO::getConversationId, conversationIds));
    }

    @Override
    public int deleteByExecutionIds(Collection<Long> executionIds) {
        if (executionIds == null || executionIds.isEmpty()) return 0;
        return toolCallMapper.delete(Wrappers.<ToolCallPO>lambdaQuery()
                .in(ToolCallPO::getExecutionId, executionIds));
    }

    @Override
    public void bindSessionMessage(String toolCallId, Long sessionMessageId) {
        if (toolCallId == null || sessionMessageId == null) return;
        findById(toolCallId).ifPresent(call -> {
            if (!sessionMessageId.equals(call.getSessionMessageId())) {
                call.bindSessionMessage(sessionMessageId);
                updateById(call);
            }
        });
    }

    @Override
    protected ToolCallPO toPO(ToolCall model) {
        if (model == null) return null;
        return ToolCallPO.builder()
                .id(model.getId())
                .conversationId(model.getConversationId())
                .sessionMessageId(model.getSessionMessageId())
                .executionId(model.getExecutionId())
                .toolName(model.getToolName())
                .type(model.getType() == null ? null : model.getType().name())
                .status(model.getStatus() == null ? null : model.getStatus().dbValue())
                .title(model.getTitle())
                .content(model.getContent())
                .rawInput(model.getRawInput())
                .rawOutput(model.getRawOutput())
                .metaData(model.getMetaData())
                .decisionCommandId(model.getDecisionCommandId())
                .decisionDigest(model.getDecisionDigest())
                .version(model.getVersion())
                .createdAt(model.getCreatedAt())
                .updatedAt(model.getUpdatedAt())
                .build();
    }

    @Override
    protected ToolCall toModel(ToolCallPO po) {
        if (po == null) return null;
        return ToolCall.builder()
                .id(po.getId())
                .conversationId(po.getConversationId())
                .sessionMessageId(po.getSessionMessageId())
                .executionId(po.getExecutionId())
                .toolName(po.getToolName())
                .type(po.getType() == null ? null : ToolCallType.valueOf(po.getType()))
                .status(ToolCallStatus.parse(po.getStatus()))
                .title(po.getTitle())
                .content(po.getContent())
                .rawInput(po.getRawInput())
                .rawOutput(po.getRawOutput())
                .metaData(po.getMetaData())
                .version(po.getVersion())
                .createdAt(po.getCreatedAt())
                .updatedAt(po.getUpdatedAt())
                .build();
    }

    /**
     * 统一按 created_at 升序（再按 id 兜底），供「取最近一条」等语义使用。
     */
    private List<ToolCall> orderByCreatedAt(LambdaQueryWrapper<ToolCallPO> wrapper) {
        return toolCallMapper.selectList(wrapper
                        .orderByAsc(ToolCallPO::getCreatedAt)
                        .orderByAsc(ToolCallPO::getId))
                .stream().map(this::toModel).toList();
    }

    @Override
    protected @NotNull BaseMapper<ToolCallPO> mapper() {
        return toolCallMapper;
    }
}
