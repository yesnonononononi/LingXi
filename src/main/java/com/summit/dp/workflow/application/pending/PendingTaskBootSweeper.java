package com.summit.dp.workflow.application.pending;

import com.summit.dp.workflow.domain.pending.repo.PendingTaskRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 启动时把上次进程遗留的待发送任务标成「待确认」。
 *
 * <p><b>为什么必须有这一步</b>：库里剩下的 PENDING 只有两种来源 —— 本进程刚入队的、
 * 和上次崩溃/关机留下的。两者都叫 PENDING，但语义完全相反：后者所在的上下文可能已经变了，
 * 自动接力等于替用户做决定。这一刷就是把两种来源分开的唯一判据（不靠时间推断）。</p>
 *
 * <p>放在 {@link ApplicationReadyEvent} 而不是 {@code @PostConstruct}：建表脚本在容器启动早期才跑完，
 * 抢在前面会偶发「表不存在」。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PendingTaskBootSweeper {

    private final PendingTaskRepository pendingTasks;

    @EventListener(ApplicationReadyEvent.class)
    public void markLegacyTasks() {
        try {
            int changed = pendingTasks.markLegacyAwaitingConfirm();
            if (changed > 0) {
                log.info("标记上次未发送的待发送任务: count={}", changed);
            }
        } catch (RuntimeException failure) {
            // 刷不动就只能记下来：此时遗留任务仍是 PENDING，会被当成新任务自动派发。
            log.error("标记遗留待发送任务失败，可能误自动派发上次未发送的消息", failure);
        }
    }
}
