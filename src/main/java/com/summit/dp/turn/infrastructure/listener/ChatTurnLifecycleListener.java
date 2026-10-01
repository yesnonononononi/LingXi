package com.summit.dp.turn.infrastructure.listener;

import com.summit.core.agent.Execution;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 用 execution 模块的生命周期端口驱动轮次状态：挂起 / 终结。
 *
 * <p><b>为什么用这个端口而不是事件</b>：本端口由 {@code LocalExecutionRepository} 在 loop 边界
 * 广播（{@code unregister} 与「取消一个挂起中的执行」两条路径），它覆盖了事件覆盖不到的一处 ——
 * <b>取消挂起中的执行</b>（{@code requireCancel} 只保存 + 广播本端口，不发事件）。
 * 若不接这里，被用户停掉的等待中轮次会永远停在 WAITING（收尸也不碰 WAITING）。</p>
 *
 * <p><b>终态与结束时间从「执行摘要」读，不反序列化 snapshot</b>：端口只给 executionId，
 * 而 snapshot 是 LONGTEXT（可能上百 KB），为了终态与一个时间戳把整段对话反序列化一次是不划算的。
 * 摘要（{@code status / completed_at}）在每次检查点保存时同步维护，且框架的顺序是
 * 「状态转移 → 保存检查点 → 通知」，因此这里读到的一定是已落库的终态。</p>
 *
 * <p><b>用量不在这里</b>：模型与 token 是业务事实，权威在轮次表本身 —— 用量由
 * {@link ChatTurnRuntimeListener} 从三个终态事件（完成 / 失败 / 取消）的 {@code tokenInfo}
 * 覆盖写入。本端口只给 executionId、给不出用量；且「取消挂起中的执行」那条路框架不发事件，
 * 该轮用量保持 null（未采集到），不猜、不补 0。</p>
 *
 * <p><b>不抛异常</b>：观察链路不得影响执行本身。框架对端口调用也做了兜底，这里再兜一层，
 * 保证任何解析/落库失败都只留下告警。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ChatTurnLifecycleListener implements ExecutionLifecycleListener {

    private static final String LOG_PREFIX = "【chat-turn】";

    private final ChatTurnService chatTurnService;
    private final ExecutionQueryService executionQueryService;

    /** 挂起不是终态：只把轮次标为 WAITING，不写结束时间。 */
    @Override
    public void onExecutionSuspended(String executionId) {
        guard(executionId, "onExecutionSuspended", () -> chatTurnService.markWaiting(executionId));
    }

    @Override
    public void onExecutionFinished(String executionId, Execution execution) {
        guard(executionId, "onExecutionFinished", () -> finishFromSummary(executionId));
    }

    private void finishFromSummary(String executionId) {
        Long id = ExecutionIdentity.numericOrNull(executionId);
        if (id == null) {
            return;
        }
        ExecutionQueryService.ExecutionSummary summary =
                executionQueryService.summariesByIds(List.of(id)).get(id);
        if (summary == null) {
            log.debug("{} 终结信号跳过：查不到执行摘要 executionId={}", LOG_PREFIX, executionId);
            return;
        }
        ChatTurnStatus status = ChatTurnStatus.of(summary.status());
        if (status == null || !status.isTerminal()) {
            // 挂起会走 onExecutionSuspended；这里出现非终态说明调用时序与预期不符，不猜、不改。
            log.debug("{} 终结信号跳过：执行状态不是终态 status={} executionId={}",
                    LOG_PREFIX, summary.status(), executionId);
            return;
        }
        // 用量传 null：它由完成事件单独覆盖写入（本路径也可能在用量已知之后才到达，
        // 而领域的终态写入是「null 不覆盖已知值」，所以先写后写都不会把数字冲掉）。
        chatTurnService.markTerminal(executionId, status, null, null, null, summary.completedAt());
    }

    private void guard(String executionId, String hook, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException e) {
            log.warn("{} {} 失败（不影响执行本身）: executionId={}, error={}",
                    LOG_PREFIX, hook, executionId, e.toString());
        }
    }
}
