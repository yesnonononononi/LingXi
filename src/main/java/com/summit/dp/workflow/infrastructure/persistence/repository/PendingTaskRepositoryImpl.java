package com.summit.dp.workflow.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.domain.pending.model.PendingAttachment;
import com.summit.dp.workflow.domain.pending.model.PendingTask;
import com.summit.dp.workflow.domain.pending.model.PendingTaskStatus;
import com.summit.dp.workflow.domain.pending.repo.PendingTaskRepository;
import com.summit.dp.workflow.infrastructure.persistence.mapper.PendingTaskMapper;
import com.summit.dp.workflow.infrastructure.persistence.po.PendingTaskPO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

/**
 * 待发送任务仓储实现：附件集合按 JSON 存在一列里。
 *
 * <p>读不出 JSON 时不做「容错成空集合」：那会把一条带图任务悄悄降级成纯文本发出去，
 * 用户只会看到「图没了」。宁可报错让队列停下等用户处理。</p>
 */
@Repository
@RequiredArgsConstructor
public class PendingTaskRepositoryImpl extends AbstractRepository<PendingTask, PendingTaskPO, Long>
        implements PendingTaskRepository {

    private static final TypeReference<List<PendingAttachment>> ATTACHMENTS = new TypeReference<>() {
    };

    private final PendingTaskMapper pendingTaskMapper;
    private final ObjectMapper objectMapper;

    @Override
    protected BaseMapper<PendingTaskPO> mapper() {
        return pendingTaskMapper;
    }

    @Override
    protected PendingTaskPO toPO(PendingTask entity) {
        return PendingTaskPO.builder()
                .id(entity.getId())
                .sessionId(entity.getSessionId())
                .inputText(entity.getInput())
                .attachments(writeAttachments(entity.getAttachments()))
                .modelId(entity.getModelId())
                .agentId(entity.getAgentId())
                .workspaceId(entity.getWorkspaceId())
                .requirePlan(entity.isRequirePlan())
                .status(entity.getStatus().name())
                .failure(entity.getFailure())
                .createdAt(entity.getCreatedAt())
                .updatedAt(entity.getUpdatedAt())
                .build();
    }

    @Override
    protected PendingTask toModel(PendingTaskPO po) {
        return PendingTask.restore(po.getId(), po.getSessionId(), po.getInputText(),
                readAttachments(po.getId(), po.getAttachments()),
                po.getModelId(), po.getAgentId(), po.getWorkspaceId(),
                Boolean.TRUE.equals(po.getRequirePlan()),
                PendingTaskStatus.fromName(po.getStatus()), po.getFailure(),
                po.getCreatedAt(), po.getUpdatedAt());
    }

    @Override
    public List<PendingTask> findBySession(long sessionId) {
        return findListBy(new LambdaQueryWrapper<PendingTaskPO>()
                .eq(PendingTaskPO::getSessionId, sessionId)
                .orderByAsc(PendingTaskPO::getId));
    }

    @Override
    public Optional<PendingTask> findEarliestDispatchable(long sessionId) {
        List<PendingTaskPO> rows = pendingTaskMapper.selectList(new LambdaQueryWrapper<PendingTaskPO>()
                .eq(PendingTaskPO::getSessionId, sessionId)
                .eq(PendingTaskPO::getStatus, PendingTaskStatus.PENDING.name())
                .orderByAsc(PendingTaskPO::getId));
        return rows.isEmpty() ? Optional.empty() : Optional.of(toModel(rows.getFirst()));
    }

    @Override
    public boolean existsBySession(long sessionId) {
        return pendingTaskMapper.selectCount(new LambdaQueryWrapper<PendingTaskPO>()
                .eq(PendingTaskPO::getSessionId, sessionId)) > 0;
    }

    @Override
    public int countBySession(long sessionId) {
        return Math.toIntExact(pendingTaskMapper.selectCount(new LambdaQueryWrapper<PendingTaskPO>()
                .eq(PendingTaskPO::getSessionId, sessionId)));
    }

    @Override
    public int countAll() {
        return Math.toIntExact(pendingTaskMapper.selectCount(null));
    }

    @Override
    public List<Long> findDispatchableSessions() {
        List<PendingTaskPO> rows = pendingTaskMapper.selectList(new LambdaQueryWrapper<PendingTaskPO>()
                .select(PendingTaskPO::getSessionId)
                .eq(PendingTaskPO::getStatus, PendingTaskStatus.PENDING.name())
                .groupBy(PendingTaskPO::getSessionId));
        return rows.stream().map(PendingTaskPO::getSessionId).toList();
    }

    @Override
    public int markLegacyAwaitingConfirm() {
        return pendingTaskMapper.update(null, new LambdaUpdateWrapper<PendingTaskPO>()
                .eq(PendingTaskPO::getStatus, PendingTaskStatus.PENDING.name())
                .set(PendingTaskPO::getStatus, PendingTaskStatus.AWAITING_CONFIRM.name())
                .set(PendingTaskPO::getUpdatedAt, Instant.now()));
    }

    @Override
    public int deleteBySession(long sessionId) {
        return pendingTaskMapper.delete(new LambdaQueryWrapper<PendingTaskPO>()
                .eq(PendingTaskPO::getSessionId, sessionId));
    }

    private String writeAttachments(List<PendingAttachment> attachments) {
        try {
            return objectMapper.writeValueAsString(attachments == null ? List.of() : attachments);
        } catch (JsonProcessingException failure) {
            throw new ClientException("待发送附件信息保存失败: " + failure.getOriginalMessage());
        }
    }

    private List<PendingAttachment> readAttachments(Long taskId, String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return objectMapper.readValue(json, ATTACHMENTS);
        } catch (JsonProcessingException failure) {
            throw new ClientException("待发送附件信息读取失败: taskId=" + taskId);
        }
    }
}
