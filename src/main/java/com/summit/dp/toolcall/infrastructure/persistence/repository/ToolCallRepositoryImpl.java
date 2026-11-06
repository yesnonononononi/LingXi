package com.summit.dp.toolcall.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.*;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.toolcall.infrastructure.persistence.VersionedUpdate;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.stream.Collectors;

/** 状态由领域方法推进，持久化按版本条件更新，避免旧决策覆盖新锚点。 */
@Repository
@RequiredArgsConstructor
public class ToolCallRepositoryImpl
        extends AbstractRepository<ToolCall, ToolCallPO, String>
        implements ToolCallRepository {

    private final ToolCallMapper toolCallMapper;
    private final ObjectMapper contentMapper;
    private final CardAvailabilityPolicy cardAvailability;

    @Override
    public void save(ToolCall tool) {
        super.save(tool);
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
    public void updateById(ToolCall model) {
        ToolCallPO update = toPO(model);
        long expectedVersion = model.getVersion();
        update.setVersion(VersionedUpdate.nextVersion(expectedVersion));
        int changed = toolCallMapper.update(update, Wrappers.<ToolCallPO>lambdaUpdate()
                .eq(ToolCallPO::getId, model.getId())
                .eq(ToolCallPO::getVersion, expectedVersion));
        VersionedUpdate.requireSingleRow(changed);
        model.acceptPersistedVersion(expectedVersion + 1);
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
    public List<ToolCall> listUnresolvedByConversationIds(Collection<Long> conversationIds) {
        if (conversationIds == null || conversationIds.isEmpty()) return List.of();
        return orderByCreatedAt(unresolved().in(ToolCallPO::getConversationId, conversationIds));
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

    /**
     * 存在性判定只关心「有没有这一行」，因此走 {@code COUNT(*)}。
     *
     * <p>不能退回 {@code selectById}：它会把 4 个 CLOB 列一并读出来，H2 对每个超过 256 字节的
     * CLOB 都要在 {@code copyLob} 里做临时 LOB 写放大，登记器的幂等预检每轮都会踩一次。</p>
     */
    @Override
    public boolean existsById(String id) {
        if (id == null) {
            return false;
        }
        return toolCallMapper.selectCount(Wrappers.<ToolCallPO>lambdaQuery()
                .eq(ToolCallPO::getId, id)) > 0;
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

    /**
     * 单块推送用的只读投影：只选装配工具块真正用到的列。
     *
     * <p>{@code content} / {@code raw_input} / {@code meta_data} 是 CLOB，单块推送一个都用不到，
     * 读它们等于给每次工具收尾加一次临时 LOB 写放大。返回的{@link ToolCallBlockView}字段不完整，
     * <b>只能装配块，禁止 updateById</b>。</p>
     */
    @Override
    public Optional<ToolCallBlockView> findForBlockUpsert(String id) {
        if (id == null) return Optional.empty();
        return toolCallMapper.selectList(Wrappers.<ToolCallPO>lambdaQuery()
                        .select(ToolCallPO::getId, ToolCallPO::getConversationId, ToolCallPO::getToolName,
                                ToolCallPO::getType, ToolCallPO::getStatus, ToolCallPO::getRawOutput,
                                ToolCallPO::getVersion)
                        .eq(ToolCallPO::getId, id))
                .stream().findFirst().map(this::toBlockView);
    }

    /** 只读投影的映射：只搬被 select 出来的列，其余字段一律不假装有值。 */
    private ToolCallBlockView toBlockView(ToolCallPO po) {
        if (po == null) return null;
        return new ToolCallBlockView(po.getId(), po.getConversationId(), po.getToolName(),
                po.getType() == null ? null : ToolCallType.valueOf(po.getType()),
                ToolCallStatus.parse(po.getStatus()), po.getRawOutput(), po.getVersion());
    }

    /**
     * 回填 TOOL 行锚点：只写 {@code session_message_id} 并推进版本号，不读也不写任何 CLOB。
     *
     * <p><b>为什么不走全量 {@code updateById}</b>：那条路要先 {@code findById} 读出 4 个 CLOB，
     * 再把它们原样写回，一次绑定在 H2 上就变成「4 次 CLOB 读 + 4 次临时 LOB 写」。
     * 锚点回填只关心一列，条件更新即可。</p>
     *
     * <p><b>版本号自增必须保留</b>：其他持有旧模型的写入方靠 {@code version} 条件失败来发现冲突，
     * 窄更新若不推进版本，一个持有旧快照的 {@code updateById} 就会把锚点抹掉。
     * 条件里带上「值未等于目标值」，重复绑定同一消息不会产生实际变更。</p>
     */
    @Override
    public void bindSessionMessage(String toolCallId, Long sessionMessageId) {
        if (toolCallId == null || sessionMessageId == null) return;
        toolCallMapper.update(null, Wrappers.<ToolCallPO>lambdaUpdate()
                .set(ToolCallPO::getSessionMessageId, sessionMessageId)
                // 领域方法 bindSessionMessage 会刷新 updated_at，窄更新保持同一语义。
                .set(ToolCallPO::getUpdatedAt, Instant.now())
                .setSql("version = version + 1")
                .eq(ToolCallPO::getId, toolCallId)
                .and(w -> w.isNull(ToolCallPO::getSessionMessageId)
                        .or().ne(ToolCallPO::getSessionMessageId, sessionMessageId)));
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
                // 决策命令身份必须回填：versioned 决策路径靠它判「同命令重放」，
                // 漏读会让一次点击被当成新命令再执行一遍外部副作用。
                .decisionCommandId(po.getDecisionCommandId())
                .decisionDigest(po.getDecisionDigest())
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
    protected BaseMapper<ToolCallPO> mapper() {
        return toolCallMapper;
    }
}
