package com.summit.dp.session.application.service.impl;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.summit.core.conversation.ConversationEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.command.SessionCommand;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.exception.SessionNoFoundException;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.utils.Serializer;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.dp.workspace.domain.repository.WorkspaceRepository;
import com.summit.dp.workspace.infrastructure.converter.FrameworkWorkspaceAssembler;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.Optional;

@Service
@RequiredArgsConstructor
public class SessionServiceImpl implements SessionService {
    private final SessionRepository sessionRepository;
    private final Serializer serializer;
    private final WorkspaceRepository workspaceRepository;
    private final FrameworkWorkspaceAssembler frameworkWorkspaceAssembler;

    @Override
    public Result<Long> add(SessionCommand command) {
        String name = command.name() == null || command.name().isBlank() ? "新对话" : command.name();
        ConversationEntity conversation;
        if (command.workspaceId() != null) {
            Optional<Workspace> workspace = workspaceRepository.findById(command.workspaceId());
            if (workspace.isEmpty()) {
                return Result.error("工作空间不存在: " + command.workspaceId());
            }
            com.summit.core.runtime.Workspace framework = frameworkWorkspaceAssembler.toFramework(workspace.get());
            if (framework == null) {
                return Result.error("工作空间不可用，请检查其类型与容器配置");
            }
            conversation = ConversationEntity.empty(name, framework, null, null);
        } else {
            conversation = ConversationEntity.empty(name, null, null, null);
        }
        Long id = sessionRepository.saveAndReturnId(conversation);
        return Result.success(id);
    }

    @Override
    public Result<Void> update(SessionCommand command) {
        Long id = command.id();
        ConversationEntity conversation = sessionRepository.get(id)
                .orElseThrow(SessionNoFoundException::new);
        sessionRepository.save(id, conversation.withSessionName(command.name()));
        return Result.success();
    }

    @Override
    public Result<Void> del(Long id) {
        if (sessionRepository.removeAndReturn(id).isEmpty()) {
            throw new SessionNoFoundException();
        }
        return Result.success();
    }

    @Override
    public Result<Page<SessionVO>> list(Integer page, Integer pageSize) {
        if (page == null || page < 1) {
            page = 1;
        }
        if (pageSize == null || pageSize < 1) {
            pageSize = 10;
        }
        Page<ConversationEntity> entityPage = sessionRepository.page(page, pageSize);
        Page<SessionVO> voPage = new Page<>(entityPage.getCurrent(), entityPage.getSize(), entityPage.getTotal());
        voPage.setRecords(entityPage.getRecords().stream().map(this::toVO).toList());
        return Result.success(voPage);
    }

    @Override
    public Result<SessionVO> findById(Long id) {
        ConversationEntity conversation = sessionRepository.get(id).orElse(null);
        if (conversation == null) {
            return Result.success();
        }
        return Result.success(toVO(conversation));
    }

    @Override
    public Result<Void> bindWorkspace(Long sessionId, Long workspaceId) {
        if (sessionId == null) {
            return Result.error("会话ID不能为空");
        }
        ConversationEntity conversation = sessionRepository.get(sessionId)
                .orElseThrow(SessionNoFoundException::new);
        com.summit.core.runtime.Workspace framework = null;
        if (workspaceId != null) {
            Workspace domain = workspaceRepository.findById(workspaceId).orElse(null);
            if (domain == null) {
                return Result.error("工作空间不存在: " + workspaceId);
            }
            framework = frameworkWorkspaceAssembler.toFramework(domain);
            if (framework == null) {
                return Result.error("工作空间不可用: " + workspaceId + "（请检查类型与容器配置）");
            }
        }
        // ConversationEntity 为 record，无 withWorkspace，需以 builder 重建（workspace 变更）。
        ConversationEntity updated = ConversationEntity.builder()
                .sessionId(conversation.sessionId())
                .sessionName(conversation.sessionName())
                .messages(conversation.messages())
                .tokenUsageEntity(conversation.tokenUsageEntity())
                .systemMessageEntity(conversation.systemMessageEntity())
                .workspace(framework)
                .build();
        sessionRepository.save(sessionId, updated);
        return Result.success();
    }

    private SessionVO toVO(ConversationEntity entity) {
        try {
            Long workspaceId = null;
            String workDir = null;
            if (entity.workspace() != null) {
                workspaceId = parseWorkspaceId(entity.workspace().id());
                workDir = entity.workspace().workDir();
            }
            return SessionVO.builder()
                    .id(entity.sessionId() == null ? null : Long.valueOf(entity.sessionId().toString()))
                    .name(entity.sessionName())
                    .workspaceId(workspaceId)
                    .workDir(workDir)
                    .messages(entity.messages() == null ? null : serializer.serializePolymorphic(entity.messages()))
                    .totalTokens(entity.tokenUsageEntity() == null ? 0 : entity.tokenUsageEntity().getTotalTokens())
                    .inputTokens(entity.tokenUsageEntity() == null ? 0 : entity.tokenUsageEntity().getInputTokens())
                    .outputTokens(entity.tokenUsageEntity() == null ? 0 : entity.tokenUsageEntity().getOutputTokens())
                    .systemMessage(entity.systemMessageEntity() == null ? null : entity.systemMessageEntity().text())
                    .build();
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    private Long parseWorkspaceId(String workspaceId) {
        try {
            return workspaceId == null ? null : Long.valueOf(workspaceId);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
