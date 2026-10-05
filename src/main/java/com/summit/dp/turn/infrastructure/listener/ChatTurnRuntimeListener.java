package com.summit.dp.turn.infrastructure.listener;

import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.conversation.event.ExecutionResumedEvent;
import com.summit.core.conversation.event.ExecutionStartEvent;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.turn.application.service.ChatTurnService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 用运行时事件驱动轮次的「开始执行」「失败原因」与「用量入账」语义。
 *
 * <p><b>职责切分</b>：终态的**状态与结束时间**由 {@link ChatTurnLifecycleListener} 经
 * execution 模块的生命周期端口写（那条路覆盖事件覆盖不到的「取消挂起中的执行」）；
 * 本类只补事件独有的时机 —— 开始时间、失败原因，以及三个终态事件的**用量**：</p>
 * <ul>
 *   <li>{@code EXECUTION_STARTED} —— 写入首次开始时间。框架的顺序是
 *       「状态转移 → 保存检查点 → 通知」，因此事件到达时 {@code started_at} 所需的一切已就绪；</li>
 *   <li>{@code EXECUTION_RESUMED} —— 恢复执行，**不重置**首次开始时间（总历时从第一次开始算）；</li>
 *   <li>{@code EXECUTION_FAILED} —— 先记面向用户的失败原因，再入账失败前已累计的用量；</li>
 *   <li>{@code EXECUTION_COMPLETED} / {@code EXECUTION_CANCELLED}
 *       —— 带 {@code tokenInfo}（取消带的是**结束前已累计**的部分用量），统一覆盖写到轮次上。</li>
 * </ul>
 *
 * <p><b>用量为什么挂事件而不是读 execution 表的列</b>：模型与 token 是业务事实，
 * 权威在轮次表 —— 模型由业务受理时解析写入，用量由本回调写入。执行表只留框架自己的
 * 运行记录，同一事实不再两处存放。</p>
 *
 * <p><b>覆盖语义天然幂等</b>：resume 之后再完成会**再发一次** {@code EXECUTION_COMPLETED}
 * （带该执行的最终累计值）。轮次的 {@code refreshUsage} 是覆盖而非累加，
 * 所以重复触发不会把同一执行算两遍。</p>
 *
 * <p><b>{@code tokenInfo} 为 null 一律跳过</b>：那是「未采集到」（例如首轮模型调用之前就失败），
 * 与「确实为 0」严格区分，不猜、不补 0。</p>
 *
 * <p><b>为什么显式 {@link Order}：</b>失败原因必须先于 SSE 广播提交，前端收到终态后才能立即对账到它
 * （否则存在「流已结束但原因还没写」的竞态窗口）。{@code RuntimeEventPublisher} 按注入顺序回调，
 * 本类取 {@code HIGHEST_PRECEDENCE} 保证最早执行。</p>
 */
@Slf4j
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
@RequiredArgsConstructor
public class ChatTurnRuntimeListener implements RuntimeListener {

    private static final String LOG_PREFIX = "【chat-turn】";
    /** 两个文案字段都为空时的兜底：宁可写一句模糊的失败，也不让失败不可见。 */
    private static final String FALLBACK_TEXT = "执行异常";

    private final ChatTurnService chatTurnService;

    @Override
    public void onExecutionStart(ExecutionStartEvent event) {
        if (event == null || event.executionId() == null) {
            return;
        }
        guard("onExecutionStart", event.executionId(),
                () -> chatTurnService.markRunning(event.executionId(), event.timestamp(), resolveRootSessionId(event)));
    }

    @Override
    public void onExecutionResumed(ExecutionResumedEvent event) {
        if (event == null || event.executionId() == null) {
            return;
        }
        // 传 null：恢复不是「首次开始」，领域方法只在 startedAt 为空时才赋值。
        guard("onExecutionResumed", event.executionId(),
                () -> chatTurnService.markRunning(event.executionId(), null, resolveRootSessionId(event)));
    }

    @Override
    public void onExecutionCompleted(ExecutionCompleteEvent event) {
        if (event == null) {
            return;
        }
        writeUsage(event.executionId(), event.getTokenInfo(), resolveRootSessionId(event));
    }

    /**
     * 失败是终态：先记原因，再入账失败前已累计的用量。
     *
     * <p>两步各自隔离异常 —— 原因写入失败（归属不明 / 落库失败）不得连带跳过用量更新，
     * 反之亦然；本类处于同步广播链路，异常绝不能外抛。</p>
     */
    @Override
    public void onExecutionError(ExecutionErrorEvent event) {
        if (event == null) {
            return;
        }
        recordFailureReason(event);
        writeUsage(event.executionId(), event.getTokenInfo(), resolveRootSessionId(event));
    }

    /** 取消同理。注意「不活跃的挂起执行被取消」那条路框架不发事件，只有端口 —— 该轮用量保持 null。 */
    @Override
    public void onExecutionCancelled(ExecutionCancelledEvent event) {
        if (event == null) {
            return;
        }
        writeUsage(event.executionId(), event.getTokenInfo(), resolveRootSessionId(event));
    }

    /** 失败原因只写轮次、不改状态；状态由生命周期端口按已保存的终态置为 FAILED。 */
    private void recordFailureReason(ExecutionErrorEvent event) {
        if (event.executionId() == null) {
            return;
        }
        guard("recordFailureReason", event.executionId(),
                () -> chatTurnService.recordFailureReason(event.executionId(), resolveErrorText(event), resolveRootSessionId(event)));
    }

    /** 主文案取 {@code errMsg}（与前端契约一致），缺失时退 {@code extraDes}，仍为空用兜底常量。 */
    private static String resolveErrorText(ExecutionErrorEvent event) {
        String primary = event.getErrMsg() == null ? "" : event.getErrMsg().trim();
        if (!primary.isEmpty()) {
            return primary;
        }
        String supplementary = event.getExtraDes() == null ? "" : event.getExtraDes().trim();
        return supplementary.isEmpty() ? FALLBACK_TEXT : supplementary;
    }

    /** 三个终态事件的统一用量入口；未采集到（{@code tokenInfo} 为 null）即跳过，不补 0。 */
    private void writeUsage(String executionId, TokenInfo usage, Long rootSessionId) {
        if (executionId == null || usage == null) {
            return;
        }
        guard("refreshUsage", executionId,
                () -> chatTurnService.refreshUsage(executionId,
                        toLong(usage.inputTokenCount()), toLong(usage.outputTokenCount()),
                        toLong(usage.totalTokenCount()), rootSessionId));
    }

    /**
     * 事件元数据里的根会话身份。
     *
     * <p>本类收到的都是**完整事件**，元数据随事件一起到达 —— 因此根身份在这里是现成的，
     * 不需要回查。缺失时返回 {@code null}（观察者会跳过该帧并告警，而不是猜）。
     * 子执行的元数据里根指向发起方，这正是「投递用根、归属用自身会话」所需的那一半。</p>
     */
    private static Long resolveRootSessionId(AgentEvent event) {
        return ExecutionEventMetadata.parseRootSessionId(event.eventMetaData());
    }

    /** 框架用量是 {@code Integer}，轮次是 BIGINT（{@code Long}）；null 原样透传，不得当成 0。 */
    private static Long toLong(Integer value) {
        return value == null ? null : value.longValue();
    }

    /**
     * 本地异常隔离：框架的事件广播在整条 {@code forEach} 之外捕获，一位监听器抛错会跳过后续监听器，
     * 所以同步观察链路上的每个动作都要各自兜底。
     */
    private void guard(String hook, String executionId, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException e) {
            log.warn("{} {} 失败（不影响执行本身）: executionId={}, error={}",
                    LOG_PREFIX, hook, executionId, e.toString());
        }
    }
}
