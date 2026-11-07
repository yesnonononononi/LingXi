package com.summit.dp.workflow.application.projection;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.shared.persistence.TransactionRetryTemplate;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;

/** 投影冲突时重放整笔事务，使读取与状态更新基于同一次尝试。 */
@Component
@RequiredArgsConstructor
public class ChatTurnLifecycleProjector {

    /** 重试器动作名，只用于日志与指标区分。 */
    private static final String RETRY_OPERATION = "投影轮次生命周期";

    private final ChatTurnService chatTurnService;

    /** 事务管理器：可选注入 —— 直接 {@code new} 出来的用例没有事务基础设施，只跑一次。 */
    @Autowired(required = false)
    private PlatformTransactionManager transactionManager;

    /**
     * 投影重试器：{@link #initRetryTemplate()} 里预建，读路径只做一次 volatile 读。
     *
     * <p>直接 {@code new} 出来的用例（含靠反射注入事务管理器的探针用例）没走 Spring 生命周期，
     * 该字段为 {@code null}，由 {@link #retryTemplate()} 现场造一个降级使用（不持有、不加锁）。</p>
     */
    private volatile TransactionRetryTemplate projectionRetry;

    /**
     * 预建重试器。
     *
     * <p>字段注入的 {@link PlatformTransactionManager} 发生在 {@code @PostConstruct} 之前，
     * 因此这里能拿到事务管理器；放在这里建可以让投影热路径在初始化之后**完全无锁**，
     * 并且指标在同一实例上累计。</p>
     */
    @PostConstruct
    void initRetryTemplate() {
        this.projectionRetry = new TransactionRetryTemplate(transactionManager, RETRY_OPERATION);
    }

    public void markExecutionWaiting(Execution execution) {
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
        retryTemplate().execute(() -> {
            chatTurnService.markWaiting(execution.getId(), rootSessionId);
            return null;
        });
    }

    public void finishExecution(Execution execution) {
        ExecutionState state = execution == null ? null : execution.getExecutionState();
        if (state == null) return;
        ChatTurnStatus terminalStatus = switch (state) {
            case COMPLETED -> ChatTurnStatus.COMPLETED;
            case FAILED -> ChatTurnStatus.FAILED;
            case CANCELLED -> ChatTurnStatus.CANCELLED;
            default -> null;
        };
        if (terminalStatus == null) return;
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
        retryTemplate().execute(() -> {
            chatTurnService.markTerminal(execution.getId(), terminalStatus, null, null, null,
                    execution.getCompletedAt(), rootSessionId);
            return null;
        });
    }

    /**
     * 按执行自身的权威快照覆盖写轮次用量。
     *
     * <p><b>为什么要有这条入口</b>：轮次用量原来只由框架终态事件的 {@code tokenInfo} 驱动
     * （{@code ChatTurnRuntimeListener}）。补偿路径（重启后的收口重做）<b>没有事件</b>：
     * 框架进程已经不存在了，只有投影还会被执行一次。没有这条入口，崩溃窗口里丢掉的用量
     * 就永久缺失。</p>
     *
     * <p><b>幂等靠覆盖写而不是去重</b>：写入值取 {@code execution.tokenUsage} 这一份唯一事实，
     * 重复执行结果完全一致；{@code null} 表示未采集到，不覆盖已知值。因此同一条收口脚本跑两遍
     * 不会把同一执行算两次。</p>
     *
     * @param execution 已提交的终态执行
     */
    public void refreshUsageFromExecution(Execution execution) {
        TokenInfo usage = execution == null ? null : TokenInfo.from(execution.getTokenUsage());
        if (usage == null) {
            return;
        }
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
        retryTemplate().execute(() -> {
            chatTurnService.refreshUsage(execution.getId(),
                    toLong(usage.inputTokenCount()), toLong(usage.outputTokenCount()),
                    toLong(usage.totalTokenCount()), toLong(usage.cacheTokens()),
                    toLong(usage.reasoningTokens()), rootSessionId);
            return null;
        });
    }

    /** 框架用量是 {@code Integer}，轮次是 BIGINT（{@code Long}）；null 原样透传，不得当成 0。 */
    private static Long toLong(Integer value) {
        return value == null ? null : value.longValue();
    }

    /**
     * 取重试器：初始化完成后只有一次 volatile 读，**不抢监视器**（每次投影都会调用）。
     *
     * <p>降级路径：直接 {@code new} 出来的用例没有 Spring 生命周期，{@code @PostConstruct}
     * 不会执行，字段为 {@code null} —— 此时现场造一个用完就丢的实例（不持有、不加锁）。
     * 这些用例读的是调用时刻的 {@code transactionManager} 字段，因此反射注入后照样能重试；
     * 生产实例永远来自 {@link #initRetryTemplate()}。</p>
     */
    private TransactionRetryTemplate retryTemplate() {
        TransactionRetryTemplate prebuilt = projectionRetry;
        if (prebuilt != null) {
            return prebuilt;
        }
        // 仅直接 new 的用例会走到这里：不写回字段，避免多个线程争着发布实例。
        return new TransactionRetryTemplate(transactionManager, RETRY_OPERATION);
    }
}
