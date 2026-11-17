package com.summit.dp.workflow.application.pending;

import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.domain.pending.repo.PendingTaskRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 待发送任务的受理事务：**删除任务行与新轮次落库必须在同一个事务里**。
 *
 * <p>拆成两个事务只有两种失败形态，都不允许：行删了轮次没落（用户输入凭空消失）、
 * 轮次落了行还在（同一句话跑两轮）。</p>
 *
 * <p>为什么另起一个类：{@code @Transactional} 靠代理，写在调用方自己的私有方法上会静默失效。
 * 这也是 {@code PreparedChatExecutor.admit} 当初独立成 bean 的同一条理由。</p>
 */
@Service
@RequiredArgsConstructor
public class PendingTaskAdmission {

    private final PreparedChatExecutor chatExecutor;
    private final PendingTaskRepository pendingTasks;
    private final SessionExecutionRegistry sessionExecutionRegistry;

    @Transactional(rollbackFor = Exception.class)
    public RuntimeContext admit(RuntimeContext context, long taskId) {
        RuntimeContext committed;
        try {
            committed = chatExecutor.admit(context);
        } catch (RuntimeException | LinkageError failure) {
            // 与普通受理同口径：提交失败必须自己释放运行资格，否则会话被永久锁死在「执行中」。
            sessionExecutionRegistry.finishRoot(context.executionContext().rootSessionId(),
                    context.executionContext().executionId());
            throw failure;
        }
        pendingTasks.findById(taskId).ifPresent(pendingTasks::delete);
        return committed;
    }
}
