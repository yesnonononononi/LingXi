package com.summit.dp.session.application.service;

import com.summit.core.conversation.message.Message;
import com.summit.dp.session.application.port.SessionContextStore;
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
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * 会话的模型推理上下文：正文写 JSONL 文件，库内只留正文标识。
 *
 * <p>与对话记录无关：压缩只重写这份上下文，不动 {@code session_message} 里的一行。</p>
 */
@Service
@RequiredArgsConstructor
@Slf4j
public class ModelContextService {

    /** 重试器动作名，只用于日志与指标区分。 */
    private static final String RETRY_OPERATION = "替换会话模型上下文";

    private final SessionContextRepository repository;
    private final SessionContextStore store;

    /** 事务管理器：只用于「自己拥有事务时，整笔替换的每次重试开一个全新事务」。直接 new 的用例可缺省。 */
    @Autowired
    private PlatformTransactionManager transactionManager;

    /** 预建的重试器，热路径只做一次 volatile 读；直接 new 的用例为 null，现场造一个降级用。 */
    private volatile TransactionRetryTemplate replaceRetry;

    @PostConstruct
    void initRetryTemplate() {
        this.replaceRetry = new TransactionRetryTemplate(transactionManager, RETRY_OPERATION);
    }

    /**
     * 读取当前上下文。
     *
     * @return 行不存在返回 {@code Optional.empty()}；行存在但正文标识为空（历史行尚未迁移）同样返回空，
     *         由调用方按「没有历史」起跑
     */
    public Optional<List<Message>> find(Long sessionId) {
        if (sessionId == null) {
            return Optional.empty();
        }
        Optional<SessionContext> summary = repository.findSummary(sessionId);
        if (summary.isEmpty()) {
            return Optional.empty();
        }
        SessionContext context = summary.get();
        if (context.getSnapshotFile() == null || context.getSnapshotFile().isBlank()) {
            return Optional.empty();
        }
        return Optional.of(store.read(sessionId, context.getSnapshotFile()));
    }

    /**
     * 替换整份上下文。
     *
     * <p><b>顺序不能反</b>：先落盘拿到新正文标识，再在事务里换引用。反过来会留下「引用指向不存在的文件」
     * 的窗口，而这份上下文正是下一轮模型调用的输入。</p>
     *
     * <p><b>为什么每次都是新文件</b>：多数调用点本身就跑在外层事务里（回滚、审批落定、决策落库），
     * 恒定文件名一旦回滚就会变成「库内引用旧、磁盘内容新」。换新标识后旧文件仍是权威内容，
     * 新文件按事务结果回收：提交后删旧份，回滚后删新份。</p>
     */
    public void replace(Long sessionId, List<Message> messages) {
        if (sessionId == null) {
            throw new IllegalArgumentException("会话 ID 不能为空");
        }
        if (messages == null) {
            throw new IllegalArgumentException("模型上下文不能为空: sessionId=" + sessionId);
        }
        // 落盘放在事务与重试之外：重试只重放「读摘要 → 换引用」，不重复写文件。
        String bodyId = store.write(sessionId, messages);
        String previous;
        try {
            previous = replaceRetryTemplate().execute(() -> upsert(sessionId, bodyId));
        } catch (RuntimeException failure) {
            // 库内引用没换成，这份新文件永远不会被读到，当场删掉。
            store.delete(sessionId, bodyId);
            throw failure;
        }
        scheduleCleanup(sessionId, bodyId, previous);
    }

    /**
     * 换引用：命中就改，没命中就建第一行。
     *
     * <p>用轻量摘要判命中，绝不读旧正文 —— 替换是覆盖写，旧正文既不用来合并也不用来校验。</p>
     *
     * @return 被替换掉的旧正文标识，可空
     */
    private String upsert(Long sessionId, String bodyId) {
        Optional<SessionContext> summary = repository.findSummary(sessionId);
        SessionContext context = summary.orElseGet(() -> SessionContext.create(sessionId));
        String previous = context.getSnapshotFile();
        context.changeSnapshot(bodyId);
        if (summary.isPresent()) {
            repository.updateById(context);
        } else {
            repository.save(context);
        }
        return previous;
    }

    /**
     * 按事务结果回收文件：提交后删旧份，回滚后删本次新份。
     *
     * <p>没有活动事务（直接 new 的用例、或事务基础设施缺省）时同步删旧份 —— 此时 upsert 已经生效。</p>
     */
    private void scheduleCleanup(Long sessionId, String bodyId, String previous) {
        boolean hasPrevious = previous != null && !previous.isBlank() && !Objects.equals(previous, bodyId);
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            if (hasPrevious) {
                store.delete(sessionId, previous);
            }
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                if (hasPrevious) {
                    store.delete(sessionId, previous);
                }
            }

            @Override
            public void afterCompletion(int status) {
                if (status != STATUS_COMMITTED) {
                    // 回滚了：本次新文件没有任何引用，留着就是垃圾。
                    store.delete(sessionId, bodyId);
                }
            }
        });
    }

    /** 会话树删除：先删库行，提交后再删文件（库是权威，文件删不掉只是垃圾）。 */
    @Transactional
    public void deleteBySessionIds(List<Long> sessionIds) {
        if (sessionIds == null || sessionIds.isEmpty()) {
            return;
        }
        repository.batchDeleteBySessionIds(sessionIds);
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            store.deleteSessions(sessionIds);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                store.deleteSessions(sessionIds);
            }
        });
    }

    /** 取重试器；初始化完成后只有一次 volatile 读，不抢监视器。 */
    private TransactionRetryTemplate replaceRetryTemplate() {
        TransactionRetryTemplate prebuilt = replaceRetry;
        if (prebuilt != null) {
            return prebuilt;
        }
        // 仅直接 new 的用例会走到这里：不写回字段，避免多线程争着发布实例。
        return new TransactionRetryTemplate(transactionManager, RETRY_OPERATION);
    }
}
