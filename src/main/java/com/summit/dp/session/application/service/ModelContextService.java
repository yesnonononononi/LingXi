package com.summit.dp.session.application.service;

import com.summit.core.conversation.message.Message;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.shared.persistence.TransactionRetryTemplate;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;



import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

/** Mutable model-facing context snapshot. Compaction may replace this without affecting the transcript. */
@Service
@RequiredArgsConstructor
@Slf4j
public class ModelContextService {

    private final ObjectMapper objectMapper;
    private final SessionContextRepository repository;

    /**
     * 事务管理器：只用于「自己拥有事务时，整笔替换的每次重试开一个全新事务」。
     *
     * <p>可选注入 —— 直接 {@code new} 出来的用例没有事务基础设施，那就只尝试一次。</p>
     */
    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    /** 整笔替换的重试器；惰性创建（事务管理器是可选注入的，直接 new 的用例为 null）。 */
    private volatile TransactionRetryTemplate replaceRetry;



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

    /**
     * 替换会话的模型上下文（整笔事务重试）。
     *
     * <p><b>为什么不能只在原事务里做「读摘要 → 写正文」</b>：SQLite 的事务在第一次读时固定快照。
     * 两个会话并发替换上下文时，A 提交后 B 在自己的旧快照上写会立刻收到
     * {@code SQLITE_BUSY_SNAPSHOT}（真实事故现场：{@code ModelContextService.replace:55}）。
     * 在过期读事务里重试 UPDATE 永远不会成功，必须整笔丢弃、换新事务重新读。</p>
     *
     * <p><b>序列化放在重试边界之外</b>：正文只序列化一次（可能几十 MB），重试的只是
     * 「读摘要 + 版本条件写」这一小段。同样的入参序列化结果相同 ⇒ 重放是幂等的。</p>
     *
     * <p>语义不变：仍走领域方法 {@link SessionContext#changeContent(String)} 写入（版本照样 +1），
     * 仍然只读摘要不读旧正文，不引入缓存，正文仍只存在 SQLite 里。</p>
     *
     * @param sessionId 会话标识
     * @param messages  新的模型上下文
     */
    public void replace(Long sessionId, List<Message> messages) {
        if (sessionId == null) {
            throw new IllegalArgumentException("会话 ID 不能为空");
        }
        if (messages == null) {
            throw new IllegalArgumentException("模型上下文不能为空: sessionId=" + sessionId);
        }
        // 序列化在事务外做一次：重试只重放「读摘要 → 版本条件写」。
        String content = serialize(sessionId, messages);
        replaceRetryTemplate().execute(() -> {
            upsert(sessionId, content);
            return null;
        });
    }

    /** 读摘要判命中再写：每次调用都必须发生在（可能是全新的）事务里。 */
    private void upsert(Long sessionId, String content) {
        // Upsert：session_context 没有独立的初始化写入方，首聊收尾/恢复/压缩都经本方法落第一行。
        // 框架仓储 save=INSERT、updateById=UPDATE（对不存在行静默 0 行），必须按是否命中分支。
        //
        // 这里用**轻量摘要**（只读 session_id / version）判命中，绝不读旧正文：
        // 替换是覆盖写，旧正文既不用来合并也不用来校验，读它只会把几十 MB 上下文搬进堆。
        Optional<SessionContext> summary = repository.findSummary(sessionId);
        SessionContext context = summary.orElseGet(() -> SessionContext.create(sessionId));
        context.changeContent(content);
        if (summary.isPresent()) {
            repository.updateById(context);
        } else {
            repository.save(context);
        }
    }

    private String serialize(Long sessionId, List<Message> messages) {
        try {
            return objectMapper.writeValueAsString(messages);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Failed to serialize model context for session " + sessionId, e);
        }
    }

    /** 惰性创建重试器：事务管理器是可选注入，创建后复用同一个实例以累计指标。 */
    private TransactionRetryTemplate replaceRetryTemplate() {
        TransactionRetryTemplate existing = replaceRetry;
        if (existing != null) {
            return existing;
        }
        synchronized (this) {
            if (replaceRetry == null) {
                replaceRetry = new TransactionRetryTemplate(transactionManager, "替换会话模型上下文");
            }
            return replaceRetry;
        }
    }

    @Transactional
    public void deleteBySessionIds(List<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return;
        repository.batchDeleteBySessionIds(sessionIds);
    }
}
