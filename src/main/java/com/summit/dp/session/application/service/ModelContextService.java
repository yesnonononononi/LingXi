package com.summit.dp.session.application.service;

import com.summit.core.conversation.message.Message;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;



import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

/** Mutable model-facing context snapshot. Compaction may replace this without affecting the transcript. */
@Service
@RequiredArgsConstructor
public class ModelContextService {

    private final ObjectMapper objectMapper;
    private final SessionContextRepository repository;



    public Optional<List<Message>> find(Long sessionId) {
        Optional<SessionContext> context = repository.findById(sessionId);
        if (context.isEmpty()) return Optional.empty();
        try {
            return Optional.of(objectMapper.readValue(context.get().getContent(), new TypeReference<>() {
            }));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to restore model context for session " + sessionId, e);
        }
    }

    @Transactional
    public void replace(Long sessionId, List<Message> messages) {
        // Upsert：session_context 没有独立的初始化写入方，首聊收尾/恢复/压缩都经本方法落第一行。
        // 框架仓储 save=INSERT、updateById=UPDATE（对不存在行静默 0 行），必须按是否命中分支。
        Optional<SessionContext> found = repository.findById(sessionId);
        SessionContext context = found.orElseGet(() -> SessionContext.create(sessionId));
        try {
            context.changeContent(objectMapper.writeValueAsString(messages));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize model context for session " + sessionId, e);
        }
        if (found.isPresent()) {
            repository.updateById(context);
        } else {
            repository.save(context);
        }
    }

    @Transactional
    public void deleteBySessionIds(List<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return;
        repository.batchDeleteBySessionIds(sessionIds);
    }
}
