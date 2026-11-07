package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * 后台任务通道：注入已结束但还没交付过的任务结果，并提供「还有任务在跑」的依赖判定。
 *
 * <h2>「已投递」这个事实需不需要新加领域字段？结论：不需要</h2>
 *
 * <p>现成机制已经满足权威判据的三条要求：</p>
 * <ol>
 *   <li><b>随检查点持久化</b>：回执集合存在 {@code execution} 的运行时属性
 *       （{@link BackgroundTaskNotifications#RECEIPTS}）里，跟着检查点一起落库，重启后仍在；</li>
 *   <li><b>不丢</b>：追加消息在前、写回执在后，且两者都在同一份内存执行对象上，
 *       落库是原子的。崩溃若发生在检查点之前，回执没落库 → 重启重新注入一次（重复而非丢失）；</li>
 *   <li><b>不靠猜</b>：判据是「这个 taskId 是否在集合里」，不是「最后一次执行时间早于任务结束时间」
 *       这类推断。</li>
 * </ol>
 *
 * <p>加一个布尔列只能表达「有没有未投递结果」，表达不了「哪几条已经投递过」，
 * 反而会退化成猜测；因此本通道沿用 RECEIPTS，不做迁移。</p>
 */
@Component
@RequiredArgsConstructor
public class BackgroundTaskChannel implements PendingInputChannel<Task> {

    /** 排在最后：本地命令的产物先让位于协作输入与恢复补充。 */
    public static final int ORDER = -650;

    private final TaskRepository tasks;
    private final BackgroundTaskNotifications notifications;

    @Override
    public int order() {
        return ORDER;
    }

    @Override
    public List<Task> pollPendingItems(Execution execution) {
        Set<String> receipts = notifications.readReceipts(execution);
        List<Task> pending = new ArrayList<>();
        for (Task task : sessionTasks(execution)) {
            if (task.getStatus().isTerminal() && !receipts.contains(task.getId().toString())) {
                pending.add(task);
            }
        }
        return pending;
    }

    @Override
    public List<String> formatForModelContext(Execution execution, List<Task> items,
                                              InputInjectionStage stage) {
        return items.stream().map(notifications::format).toList();
    }

    /**
     * 回执集合就是权威判据：写回执与追加消息在同一份执行对象上，随同一次检查点落库。
     *
     * <p>只对本次真正投递的条目打回执 —— 若为「查到的全部」打回执，会把别的执行实例
     * 也在等的结果提前标成已交付。</p>
     */
    @Override
    public void markConsumed(Execution execution, List<Task> items) {
        if (items.isEmpty()) {
            return;
        }
        Set<String> receipts = new LinkedHashSet<>(notifications.readReceipts(execution));
        items.forEach(task -> receipts.add(task.getId().toString()));
        InputAutomationPolicy.putAttribute(execution, BackgroundTaskNotifications.RECEIPTS,
                List.copyOf(receipts));
    }

    @Override
    public boolean hasOpenAsyncDependency(Execution execution) {
        return sessionTasks(execution).stream().anyMatch(task -> !task.getStatus().isTerminal());
    }

    /** 任务归属本执行（会话 + 执行 id 双限定），不会串到同会话的其它执行上。 */
    private List<Task> sessionTasks(Execution execution) {
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId == null) {
            return List.of();
        }
        return tasks.findByExecutionId(ExecutionIdentity.sessionId(execution), executionId);
    }
}
