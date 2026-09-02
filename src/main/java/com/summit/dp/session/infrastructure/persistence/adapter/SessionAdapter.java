package com.summit.dp.session.infrastructure.persistence.adapter;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.summit.core.conversation.ConversationEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.runtime.Workspace;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.shared.utils.Serializer;
import com.summit.dp.workspace.domain.repository.WorkspaceRepository;
import com.summit.dp.workspace.infrastructure.converter.FrameworkWorkspaceAssembler;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.Serializable;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * 会话持久化适配器：承担 agent 运行期会话历史的读写（ConversationStore）。
 * <p>workspace 按 {@code workspace_id} 关联独立表存储，读取时经
 * {@link FrameworkWorkspaceAssembler} 装配回框架运行实例并挂回会话实体
 * （对齐运行期语义，如 {@code ConversationManager.workspace(sessionId)} 依赖该还原）。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SessionAdapter implements SessionRepository {
    private final SessionMapper sessionMapper;
    private final Serializer serializer;
    private final WorkspaceRepository workspaceRepository;
    private final FrameworkWorkspaceAssembler frameworkWorkspaceAssembler;

    @Override
    public Optional<ConversationEntity> get(@NonNull Serializable sessionId) {
        Long id = toLong(sessionId);
        if (id == null) {
            return Optional.empty();
        }
        return Optional.ofNullable(sessionMapper.selectById(id)).map(this::toModel);
    }

    @Override
    public void save(@NonNull Serializable sessionId, @NonNull ConversationEntity conversation) {
        Long id = toLong(sessionId);
        ConversationEntity entity = conversation.withSessionId(sessionId);
        if (id != null && sessionMapper.selectById(id) != null) {
            sessionMapper.updateById(toPO(entity));
        } else {
            sessionMapper.insert(toPO(entity));
        }
    }

    @Override
    public Optional<ConversationEntity> removeAndReturn(@NonNull Serializable sessionId) {
        Optional<ConversationEntity> entity = get(sessionId);
        if (entity.isPresent()) {
            sessionMapper.deleteById(toLong(sessionId));
        }
        return entity;
    }

    @Override
    public Long saveAndReturnId(ConversationEntity entity) {
        SessionPO po = toPO(entity);
        sessionMapper.insert(po);
        return po.getId();
    }

    @Override
    public Page<ConversationEntity> page(int page, int pageSize) {
        Page<SessionPO> poPage = sessionMapper.selectPage(
                new Page<>(Math.max(page, 1), Math.max(pageSize, 1)),
                Wrappers.<SessionPO>lambdaQuery().orderByDesc(SessionPO::getId));
        Page<ConversationEntity> result = new Page<>(poPage.getCurrent(), poPage.getSize(), poPage.getTotal());
        Map<Long, Workspace> assembled = assembleWorkspaces(poPage.getRecords().stream()
                .map(SessionPO::getWorkspaceId)
                .filter(Objects::nonNull)
                .toList());
        result.setRecords(poPage.getRecords().stream()
                .map(po -> safeToModel(po, assembled))
                .filter(Objects::nonNull)
                .toList());
        return result;
    }

    private SessionPO toPO(ConversationEntity conversation) {
        try {
            return SessionPO.builder()
                    .id(conversation.sessionId() == null ? null : toLong(conversation.sessionId()))
                    .name(conversation.sessionName())
                    .workspaceId(toWorkspaceId(conversation.workspace()))
                    .messages(conversation.messages() == null ? null : serializer.serializePolymorphic(conversation.messages()))
                    .totalTokens(conversation.tokenUsageEntity() == null ? 0 : conversation.tokenUsageEntity().getTotalTokens())
                    .inputTokens(conversation.tokenUsageEntity() == null ? 0 : conversation.tokenUsageEntity().getInputTokens())
                    .outputTokens(conversation.tokenUsageEntity() == null ? 0 : conversation.tokenUsageEntity().getOutputTokens())
                    .systemMessage(conversation.systemMessageEntity() == null ? null : conversation.systemMessageEntity().text())
                    .build();
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize conversation", e);
        }
    }

    private ConversationEntity toModel(SessionPO po) {
        return toModel(po, assembleWorkspaces(po.getWorkspaceId() == null ? List.of() : List.of(po.getWorkspaceId())));
    }

    private ConversationEntity toModel(SessionPO po, Map<Long, Workspace> assembled) {
        try {
            List<Message> messages = po.getMessages() == null || po.getMessages().isBlank()
                    ? List.of()
                    : serializer.deserializePolymorphic(po.getMessages(), new TypeReference<List<Message>>() {});
            return ConversationEntity.builder()
                    .sessionId(po.getId())
                    .sessionName(po.getName())
                    .messages(new LinkedList<>(messages))
                    .tokenUsageEntity(TokenUsageEntity.of(po.getTotalTokens(), po.getInputTokens(), po.getOutputTokens()))
                    .systemMessageEntity(po.getSystemMessage() == null ? null
                            : SystemMessageEntity.builder().text(po.getSystemMessage()).build())
                    .workspace(po.getWorkspaceId() == null ? null : assembled.get(po.getWorkspaceId()))
                    .build();
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to deserialize conversation " + po.getId(), e);
        }
    }

    private ConversationEntity safeToModel(SessionPO po, Map<Long, Workspace> assembled) {
        try {
            return toModel(po, assembled);
        } catch (Exception e) {
            log.warn("Skip session {}: {}", po.getId(), e.getMessage());
            return null;
        }
    }

    /**
     * 按 workspace_id 批量装配为框架运行实例；装配失败(如 docker 容器信息缺失)回退 null，不阻断查询。
     */
    private Map<Long, Workspace> assembleWorkspaces(Collection<Long> workspaceIds) {
        if (workspaceIds == null || workspaceIds.isEmpty()) {
            return Map.of();
        }
        List<com.summit.dp.workspace.domain.model.Workspace> domains = workspaceRepository.findByIds(workspaceIds);
        Map<Long, Workspace> assembled = new HashMap<>();
        for (com.summit.dp.workspace.domain.model.Workspace ws : domains) {
            Workspace framework = frameworkWorkspaceAssembler.toFramework(ws);
            if (framework != null) {
                assembled.put(ws.getId(), framework);
            }
        }
        return assembled;
    }

    private Long toWorkspaceId(Workspace workspace) {
        if (workspace == null) {
            return null;
        }
        try {
            return Long.valueOf(workspace.id());
        } catch (NumberFormatException e) {
            log.warn("Workspace id is not a Long, fallback to null: {}", workspace.id());
            return null;
        }
    }

    private Long toLong(Serializable sessionId) {
        if (sessionId == null) {
            return null;
        }
        try {
            return Long.valueOf(sessionId.toString());
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
