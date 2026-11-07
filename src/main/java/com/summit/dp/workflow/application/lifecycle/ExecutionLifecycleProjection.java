package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 执行状态提交之后的业务投影：把「执行变了」翻译成「卡片、子执行、用量、轮次、界面」各自该做什么。
 *
 * <p><b>为什么单独成类</b>：这些副作用原先写在 {@code LocalExecutionRepository} 里，仓储因此
 * 直接依赖工具卡片、子执行、会话用量、业务轮次、运行时事件五个协作方 —— 一个存储组件穿着
 * 编排器的衣服，读代码时看不出「保存检查点」和「收口用户可见的轮次」是两件事。</p>
 *
 * <h2>失败语义：按因果链分两级，不是「记日志继续」</h2>
 *
 * <p>「一步失败就记日志继续」对终态收口链是错的：卡片收口失败后仍把轮次标成正常结束，界面就会
 * 「轮次已完成、卡片还亮着可点」；子执行交付失败后仍收口轮次，根会永远被判为还在等子代理。
 * 因此每一步都先回答「失败对用户意味着什么」，再据此决定它是否必须成功：</p>
 *
 * <ul>
 *   <li>{@link StepKind#REQUIRED}：失败即本次收口不完整，<b>中断后续步骤</b>，
 *       不再发布任何「成功可见结果」，由补偿入口重做（见 {@link #completeClosure}）。</li>
 *   <li>{@link StepKind#BEST_EFFORT}：失败只丢这一项信息，不影响其它步骤的结论，只记日志。</li>
 * </ul>
 *
 * <p>不完整收口会在执行属性上留下 {@value #CLOSURE_INCOMPLETE} 标记。标记的消费方：
 * {@code LocalExecutionRepository#save}（该执行下一次落库时补做）与启动巡检（已读到的快照补做）。</p>
 *
 * <p><b>事务边界</b>：本类的终态与挂起入口全部在调用方的 {@code afterCommit} 里执行 ——
 * 检查点已提交、框架终态尚未发布，所以每一步都是「提交后必然尝试一次」。崩溃恰好落在
 * 提交与收口之间时，标记来不及落库，恢复只能靠补偿路径（见未完项）。</p>
 *
 * <p><b>幂等靠状态判据，不靠「跑过一次」</b>：收卡片对已无待决策卡片是空操作；子执行结束事实
 * 按登记表的注销结果去重；轮次终态对同一终态重复通知是幂等的（{@code ChatTurnService#markTerminal}
 * 的契约）。因此补偿入口可以安全重复调用。</p>
 *
 * <p><b>协作方一律经 {@link ObjectProvider} 延迟取用</b>：这些组件（尤其 {@code SubExecutionLifecycle}）
 * 与执行仓储互为依赖，构造期直接注入会形成闭环。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ExecutionLifecycleProjection {

    /** 收口不完整标记：只放执行属性，不新增库列。 */
    public static final String CLOSURE_INCOMPLETE = "lingxi.lifecycle.closure_incomplete";

    /** 挂起路径步骤名。 */
    public static final String STEP_RELEASE_CARDS = "开放工具卡片";
    public static final String STEP_WAITING_TURN = "更新等待轮次";

    /** 终结路径步骤名。 */
    public static final String STEP_CLOSE_CARDS = "收口工具卡片";
    public static final String STEP_SUB_EXECUTION_FINISHED = "结束事实-终结";
    public static final String STEP_SAVE_USAGE = "保存会话用量";
    public static final String STEP_FINISH_TURN = "收口业务轮次";
    public static final String STEP_RESUME_PENDING_INPUT = "自动唤醒复查";

    /** 取消路径额外步骤名：终态事件必须在业务轮次收口之后补发。 */
    public static final String STEP_PUBLISH_CANCELLED = "发布取消终态";

    /** 步骤级别：决定失败后中断还是继续。 */
    public enum StepKind {
        /** 失败即收口不完整，必须中断并等补偿重做。 */
        REQUIRED,
        /** 失败只丢这一项信息，不影响其它步骤的结论。 */
        BEST_EFFORT
    }

    /**
     * 一次收口的结果：调用方据此判断「能不能当作成功发布」。
     *
     * @param complete         必须成功的步骤是否全部完成
     * @param failedRequired   未完成的必须步骤名（按执行顺序）
     * @param failedBestEffort 失败的尽力步骤名（按执行顺序）
     */
    public record ClosureOutcome(boolean complete, List<String> failedRequired, List<String> failedBestEffort) {

        /** 紧凑构造：列表不可变，避免调用方改到内部状态。 */
        public ClosureOutcome {
            failedRequired = List.copyOf(failedRequired);
            failedBestEffort = List.copyOf(failedBestEffort);
        }
    }

    /** 一个步骤：名字进日志与结果，级别决定失败后的走向。 */
    private record Step(String name, StepKind kind, Runnable action) {
    }

    private final ObjectProvider<ToolCallReadinessService> readinessService;
    private final ObjectProvider<ToolCallService> toolCallService;
    private final ObjectProvider<SubExecutionLifecycle> subExecutionLifecycle;
    private final ObjectProvider<SessionContextUsageProjector> sessionUsage;
    private final ObjectProvider<ChatTurnLifecycleProjector> chatTurns;
    private final ObjectProvider<RuntimeEventPublisher> runtimeEvents;
    private final ObjectProvider<InputWakeupService> inputWakeups;

    /**
     * 落库前补写「用户暂停」意图。
     *
     * <p><b>为什么放在写检查点之前</b>：{@code register} 见到 {@code USER_PAUSED} 会直接拒绝登记，
     * 标记与「停在挂起点」这个事实必须同一次提交落库，否则重启后执行看起来还能被恢复。</p>
     *
     * <p><b>为什么不分级</b>：它是检查点内容的一部分 —— 写不进去就不该提交这份检查点，
     * 吞掉异常等于让库里的状态与内存里的意图不一致。</p>
     *
     * @param execution       待保存的执行
     * @param suspendRequired 控制槽位是否要求本次停在挂起点
     */
    public void applyPauseIntent(Execution execution, boolean suspendRequired) {
        if (!suspendRequired || execution.getExecutionState() != ExecutionState.SUSPENDED) {
            return;
        }
        InputAutomationPolicy.putAttribute(execution, InputAutomationPolicy.USER_PAUSED, true);
    }

    /**
     * 挂起投影：卡片重新可决策、轮次标记为等待中。
     *
     * <p><b>顺序理由</b>：先开放卡片再改轮次状态。轮次的「等待中」是界面对用户的承诺，
     * 卡片还没开放就标等待，用户会看到一个没有任何可操作项的等待轮次。</p>
     *
     * <p><b>为什么两步都不中断</b>：它们各是一份独立信息，且都不会产出「成功结束」这种假结果 ——
     * 卡片没开但轮次标了等待，用户还能靠手动 {@code /resume} 走出来；两步都放弃，轮次会停在
     * 「运行中」，那才是真的走不出来。</p>
     *
     * @param execution 已提交的挂起执行
     * @return 本次挂起投影结果；未完成项只作记录，不影响下一轮保存重做
     */
    public ClosureOutcome onSuspended(Execution execution) {
        return runChain(execution, List.of(
                step(STEP_RELEASE_CARDS, StepKind.BEST_EFFORT,
                        () -> readinessService.getObject().markReady(execution.getId())),
                step(STEP_WAITING_TURN, StepKind.BEST_EFFORT,
                        () -> chatTurns.getObject().markExecutionWaiting(execution))));
    }

    /**
     * 终结投影：把各模块的收尾按因果顺序走完。
     *
     * <p><b>顺序不可交换，逐条说明依赖与失败后果</b>：</p>
     * <ol>
     *   <li>{@value #STEP_CLOSE_CARDS}（必须）：先收掉还挂着的询问/审批卡片。失败后果 ——
     *       界面展示一个已结束执行的可点卡片，用户点下去就是对已终结执行做决策；后面每一步
     *       都以「没有待处理卡片」为前提，所以失败必须中断。</li>
     *   <li>{@value #STEP_SUB_EXECUTION_FINISHED}（必须）：子执行结束事实在卡片收口之后。
     *       失败后果 —— 根执行仍被判为「还在等这个子代理」，永远不会收尾，比轮次没收口严重；
     *       因此失败同样中断，不许把子执行所在轮次标成正常结束让用户以为链路走通了。</li>
     *   <li>{@value #STEP_SAVE_USAGE}（尽力）：失败只导致用量/计费少记一段，不影响任何状态结论。</li>
     *   <li>{@value #STEP_FINISH_TURN}（必须）：业务轮次最后写，它是用户可见的最终状态。
     *       失败后果 —— 轮次永远停在「进行中」，必须由补偿入口重做。</li>
     *   <li>{@value #STEP_RESUME_PENDING_INPUT}（尽力）：全部落库状态改完才复查输入队列。
     *       失败只是「已排队输入晚一点被拉起」，用户下一次输入会重新触发。</li>
     * </ol>
     *
     * <p><b>本方法必须早于框架终态事件</b>：框架的顺序是「save(FAILED) → 返回发布任务 → 调用方 run 它」，
     * 业务侧没有排序权，只能在保存提交后、框架发布之前把轮次收口补上；否则界面会先收到终态、
     * 后收到轮次更新，出现「执行结束了但轮次还转着」的瞬间。</p>
     *
     * @param execution 已提交的终态执行
     * @return 本次终结投影结果；{@code complete=false} 表示必须成功的一步没做成
     */
    public ClosureOutcome onFinished(Execution execution) {
        return runChain(execution, finishChain(execution));
    }

    /**
     * 取消投影：终结投影 + 补发取消终态事件。
     *
     * <p>终态事件排在业务轮次收口之后：订阅方拿到「已取消」时应当能同时读到已收口的轮次，
     * 否则前端会先清空执行、再收到一次轮次更新。</p>
     *
     * <p>终结投影不完整时<b>不广播取消</b>：广播出去的「已取消」是用户可见的成功结果，
     * 而轮次此时还没收口，两者互相矛盾。</p>
     *
     * @param execution 已提交的取消执行
     * @return 合成结果：终结与广播任一未完成即为不完整
     */
    public ClosureOutcome onCancelled(Execution execution) {
        ClosureOutcome finished = onFinished(execution);
        if (!finished.complete()) {
            return finished;
        }
        ClosureOutcome cancelled = runChain(execution, List.of(
                step(STEP_PUBLISH_CANCELLED, StepKind.REQUIRED,
                        () -> runtimeEvents.getObject().onExecutionCancelled(
                                new ExecutionCancelledEvent(execution.getId(),
                                        TokenInfo.from(execution.getTokenUsage()), execution.eventMetaData())))));
        return merge(finished, cancelled);
    }

    /**
     * 补偿入口：重做一次收口，靠状态判据去重，可安全重复调用。
     *
     * <p><b>谁调它</b>：①该执行下一次落库时（{@code LocalExecutionRepository#save} 见到
     * {@value #CLOSURE_INCOMPLETE} 标记就补做）；②启动巡检对已读到的执行快照补做。</p>
     *
     * <p><b>为什么不重发终态广播</b>：广播是一次性通知，重发会让订阅方收到两次「已取消」；
     * 而轮次终态本身已是可观测的收敛点，漏掉的广播不会让界面停在错误状态 —— 重复比缺失更难容忍，
     * 所以补偿只补业务状态。</p>
     *
     * @param execution 需要补做收口的执行
     * @return 补偿结果；未到终态的执行返回不完整且不做任何副作用
     */
    public ClosureOutcome completeClosure(Execution execution) {
        if (execution == null || execution.getId() == null || execution.getExecutionState() == null) {
            return new ClosureOutcome(false, List.of(), List.of());
        }
        if (!isTerminal(execution.getExecutionState())) {
            // 未到终态的执行没有「收口」可补：替它补终态等于替用户做结束决定。
            return new ClosureOutcome(false, List.of(), List.of());
        }
        return onFinished(execution);
    }

    /** 终态判据只在这里用一次：application 层不反向依赖 harness 的状态编码器。 */
    private static boolean isTerminal(ExecutionState state) {
        return state == ExecutionState.COMPLETED || state == ExecutionState.FAILED
                || state == ExecutionState.CANCELLED;
    }

    /**
     * 自动唤醒复查：执行停下之后，队列里可能已经有输入在等它。
     *
     * <p>必须放在所有落库动作之后调用：复查读的是落库状态，提前调用会让唤醒基于旧事实判断。</p>
     *
     * @param execution 已提交的执行
     */
    public void resumeInputIfPending(Execution execution) {
        if (inputWakeups == null || execution == null || execution.getId() == null) {
            return;
        }
        runChain(execution, List.of(step(STEP_RESUME_PENDING_INPUT, StepKind.BEST_EFFORT,
                () -> inputWakeups.getObject().resumeIfInputPending(Long.parseLong(execution.getId())))));
    }

    /** 终结链：顺序与级别见 {@link #onFinished} 的 Javadoc。 */
    private List<Step> finishChain(Execution execution) {
        return List.of(
                step(STEP_CLOSE_CARDS, StepKind.REQUIRED,
                        () -> toolCallService.getObject().cancelPendingToolCalls(execution.getId())),
                step(STEP_SUB_EXECUTION_FINISHED, StepKind.REQUIRED,
                        () -> subExecutionLifecycle.getObject().onFinished(execution)),
                step(STEP_SAVE_USAGE, StepKind.BEST_EFFORT,
                        () -> sessionUsage.getObject().saveExecutionContextUsage(execution)),
                step(STEP_FINISH_TURN, StepKind.REQUIRED,
                        () -> chatTurns.getObject().finishExecution(execution)),
                step(STEP_RESUME_PENDING_INPUT, StepKind.BEST_EFFORT,
                        () -> inputWakeups.getObject().resumeIfInputPending(Long.parseLong(execution.getId()))));
    }

    private static Step step(String name, StepKind kind, Runnable action) {
        return new Step(name, kind, action);
    }

    /**
     * 按链执行步骤。
     *
     * <p>必须成功的步骤失败即中断：继续往下走就会产出「轮次已完成」这种带着缺失事实的成功结果。
     * 尽力步骤失败只记日志。结论落到 {@value #CLOSURE_INCOMPLETE} 标记上 —— 标记被清除
     * 说明这一刻收口是完整的。</p>
     */
    private ClosureOutcome runChain(Execution execution, List<Step> chain) {
        List<String> failedRequired = new ArrayList<>();
        List<String> failedBestEffort = new ArrayList<>();
        for (Step current : chain) {
            try {
                current.action().run();
            } catch (RuntimeException error) {
                log.error("执行生命周期处理失败: executionId={}, step={}, level={}",
                        execution == null ? null : execution.getId(), current.name(), current.kind(), error);
                if (current.kind() == StepKind.REQUIRED) {
                    failedRequired.add(current.name());
                    break;
                }
                failedBestEffort.add(current.name());
            }
        }
        boolean complete = failedRequired.isEmpty();
        mark(execution, !complete);
        return new ClosureOutcome(complete, failedRequired, failedBestEffort);
    }

    /** 标记只表达「这一刻收口是否完整」；重入去重不依赖它，靠各协作方的状态判据。 */
    private void mark(Execution execution, boolean incomplete) {
        if (execution == null || execution.getAgentRequest() == null) {
            return;
        }
        InputAutomationPolicy.putAttribute(execution, CLOSURE_INCOMPLETE, incomplete ? Boolean.TRUE : null);
    }

    private static ClosureOutcome merge(ClosureOutcome first, ClosureOutcome second) {
        List<String> required = new ArrayList<>(first.failedRequired());
        required.addAll(second.failedRequired());
        List<String> bestEffort = new ArrayList<>(first.failedBestEffort());
        bestEffort.addAll(second.failedBestEffort());
        return new ClosureOutcome(required.isEmpty(), required, bestEffort);
    }
}
