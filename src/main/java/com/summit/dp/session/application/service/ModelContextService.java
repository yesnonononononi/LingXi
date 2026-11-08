package com.summit.dp.session.application.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.Message;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.shared.persistence.TransactionRetryTemplate;
import jakarta.annotation.PostConstruct;
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

    /** 重试器动作名，只用于日志与指标区分。 */
    private static final String RETRY_OPERATION = "替换会话模型上下文";

    private final ObjectMapper objectMapper;
    private final SessionContextRepository repository;

    /**
     * 事务管理器：只用于「自己拥有事务时，整笔替换的每次重试开一个全新事务」。
     *
     * <p>可选注入 —— 直接 {@code new} 出来的用例没有事务基础设施，那就只尝试一次。</p>
     */
    @Autowired
    private PlatformTransactionManager transactionManager;

    /**
     * 整笔替换的重试器：{@link #initRetryTemplate()} 里预建，读路径只做一次 volatile 读。
     *
     * <p>直接 {@code new} 出来的用例没走 Spring 生命周期，该字段为 {@code null}，
     * 由 {@link #replaceRetryTemplate()} 现场造一个降级使用（不持有、不加锁）。</p>
     */
    private volatile TransactionRetryTemplate replaceRetry;

    /**
     * 预建重试器。
     *
     * <p>字段注入的 {@link PlatformTransactionManager} 发生在 {@code @PostConstruct} 之前，
     * 因此这里能拿到事务管理器。放在这里建而不是每次调用时 double-check，
     * 是为了让热路径（每轮对话都会 {@code replace}）在初始化之后**完全无锁**，
     * 同时重试指标在同一实例上累计。</p>
     */
    @PostConstruct
    void initRetryTemplate() {
        this.replaceRetry = new TransactionRetryTemplate(transactionManager, RETRY_OPERATION);
    }

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

    /** 上下文版本竞争时重试整笔事务，保证摘要与正文基于同一版本。副作用必须留在重试边界之外。 */
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

    /**
     * 取重试器：初始化完成后只有一次 volatile 读，**不抢监视器**（热路径每轮对话都会调用）。
     *
     * <p>降级路径：直接 {@code new} 出来的用例没有 Spring 生命周期，{@code @PostConstruct}
     * 不会执行，字段为 {@code null} —— 此时现场造一个用完就丢的实例（不持有、不加锁），
     * 保证这些用例照样能跑；生产实例永远来自 {@link #initRetryTemplate()}。</p>
     */
    private TransactionRetryTemplate replaceRetryTemplate() {
        TransactionRetryTemplate prebuilt = replaceRetry;
        if (prebuilt != null) {
            return prebuilt;
        }
        // 仅直接 new 的用例会走到这里：不写回字段，避免多个线程在这里争着发布实例。
        return new TransactionRetryTemplate(transactionManager, RETRY_OPERATION);
    }

    @Transactional
    public void deleteBySessionIds(List<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) return;
        repository.batchDeleteBySessionIds(sessionIds);
    }
}
