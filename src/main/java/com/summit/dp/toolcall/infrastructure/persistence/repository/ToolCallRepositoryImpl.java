package com.summit.dp.toolcall.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO;
import lombok.RequiredArgsConstructor;
import org.jetbrains.annotations.NotNull;
import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.stream.Collectors;

/**
 * {@code tool_call} 表仓储实现。
 *
 * <p>{@code updateById} 由基类提供：调用方先把 {@link ToolCall} 流转到目标状态，再整行落库。
 * 本类刻意不提供「直接改 status 列」的方法，状态推进只认充血模型的结论。</p>
 */
@Repository
@RequiredArgsConstructor
public class ToolCallRepositoryImpl
        extends AbstractRepository<ToolCall, ToolCallPO, String>
        implements ToolCallRepository {

    private final ToolCallMapper toolCallMapper;

    @Override
    public List<ToolCall> listByIds(Collection<String> ids) {
        if (ids == null || ids.isEmpty()) return List.of();
        return toolCallMapper.selectList(new LambdaQueryWrapper<ToolCallPO>()
                .in(ToolCallPO::getId, ids)
                .eq(ToolCallPO::getStatus, ToolCallStatus.PENDING.dbValue())
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
    public void bindSessionMessage(String toolCallId, Long sessionMessageId) {
        if (toolCallId == null || sessionMessageId == null) return;
        ToolCallPO update = new ToolCallPO();
        update.setSessionMessageId(sessionMessageId);
        toolCallMapper.update(update, Wrappers.<ToolCallPO>lambdaUpdate()
                .eq(ToolCallPO::getId, toolCallId));
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
