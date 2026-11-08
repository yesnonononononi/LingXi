package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.application.decision.ToolCallReadinessService;
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
 * <h2>一条显式脚本，不抽象分级</h2>
 *
 * <p>终结收口只有<b>一条</b>链：收口工具卡片 → 子执行结束事实 → 会话用量 → 收口业务轮次，
 * 取消时再多一步「发布取消终态」。顺序是硬编码的方法调用序列，谁想改顺序都得改这份方法体，
 * 不需要、也不允许再引入「步骤级别枚举」这种只有一个用例的抽象。</p>
 *
 * <p>失败语义按<b>用户可见后果</b>分两类，落在代码里就是「抛或不抛」：</p>
 * <ul>
 *   <li><b>必须成功</b>（卡片、子执行结束事实、会话用量、业务轮次、取消广播）：失败即抛
 *       {@link ExecutionClosureFailure}，<b>立即中断后续步骤</b>，不再产出「成功可见结果」。
 *       后果举例 —— 子执行结束事实没做成，根会永远被判为「还在等子代理」；轮次没收口，
 *       界面永远停在「进行中」；用量没写成，计费与用量视图永久缺这一段。</li>
 *   <li><b>尽力而为</b>（自动唤醒复查）：失败只丢这一项信息，下一次输入会重新触发。</li>
 * </ul>
 *
 * <h2>通知（SSE 广播）与业务事实的边界</h2>
 *
 * <p><b>业务事实先落库、清位，再发通知</b>：卡片 / 子执行 / 用量 / 轮次写完之后才清
 * 「待收口位」，清位之后才广播「已取消」并唤醒输入队列 —— 否则订阅方可能收到一条指向
 * 没收口轮次的通知。</p>
 *
 * <p><b>通知失败不回退任何业务事实</b>：广播在清位之后执行，抛异常只记日志（带
 * {@code executionId} 与步骤名），既不会把待收口位重新置 1，也不会回滚已提交的轮次 / 卡片 /
 * 用量 —— 那些是库里的既成事实，不应因为「没有观众」而被抹掉。客户端靠 bootstrap 与轮次终态
 * 快照收敛：少一帧「已取消」不会让状态错乱，而丢掉业务事实会。</p>

 *
 * <h2>事务边界：提交后投影失败 = 可重试的待办事实，不是丢数据</h2>
 *
 * <p>本类的终态入口全部在调用方的 {@code afterCommit} 里执行 —— 检查点已提交、框架终态尚未发布。
 * 因此：</p>
 * <ul>
 *   <li><b>投影失败不回滚终态</b>：轮回滚会让执行卡在 RUNNING，比「收口没做完」更糟；</li>
 *   <li><b>回滚语义只留在状态提交事务本身</b>：检查点写失败仍整笔回滚；</li>
 *   <li><b>可恢复性靠库列</b>：`execution.closure_pending` 与「写成终态」由同一条 UPDATE 写入
 *       （见 {@code V5__execution_closure_pending.sql}），所以崩溃落在提交与收口之间时，
 *       重启后的 {@code ExecutionStartupReaper} 能按这一列把活捞回来重做 ——
 *       不依赖任何内存标记，也不依赖遗留恢复请求。</li>
 * </ul>
 *
 * <p><b>广播与唤醒一律排在「清掉待收口位」之后</b>：先把「收口做完了」这个事实写进库，
 * 再对外发「已取消」和唤醒输入队列；否则订阅方可能收到一条指向没收口轮次的通知。</p>
 *
 * <p><b>幂等靠状态判据，不靠「跑过一次」</b>：收卡片对已无待决策卡片是空操作；子执行结束事实
 * 按登记表的注销结果去重；轮次终态对同一终态重复通知是幂等的（{@code ChatTurnService#markTerminal}
 * 的契约）。因此同一条脚本可以安全重复执行。</p>
 *
 * <p><b>协作方一律经 {@link ObjectProvider} 延迟取用</b>：这些组件（尤其 {@code SubExecutionLifecycle}）
 * 与执行仓储互为依赖，构造期直接注入会形成闭环。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ExecutionLifecycleProjection {

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

    /** 补偿路径步骤名：补发被通知层门禁拦下的成功终态。 */
    public static final String STEP_PUBLISH_COMPLETED = "补发成功终态";

    /** 收口成功后清「待收口位」这个动作的名字。 */
    public static final String STEP_CLEAR_PENDING = "清除待收口位";

    /**
     * 必须成功的步骤失败时抛出：带步骤名，供日志定位与调用方判定。
     *
     * <p><b>为什么不吞异常</b>：吞掉就等于「用日志包住静默丢失」—— 卡片/轮次/子执行就真的没人补了。
     * 抛出去之后库里的待收口位仍是 1，下次启动巡检或该执行下一次落库会重做同一条脚本。</p>
     */
    public static class ExecutionClosureFailure extends RuntimeException {
        private final String step;

        public ExecutionClosureFailure(String step, Throwable cause) {
            super("执行收口失败: step=" + step, cause);
            this.step = step;
        }

        /** 失败的步骤名（见本类的 {@code STEP_*} 常量）。 */
        public String step() {
            return step;
        }
    }

    private final ObjectProvider<ToolCallReadinessService> readinessService;
    private final ObjectProvider<ToolCallService> toolCallService;
    private final ObjectProvider<SubExecutionLifecycle> subExecutionLifecycle;
    private final ObjectProvider<SessionContextUsageProjector> sessionUsage;
    private final ObjectProvider<ChatTurnLifecycleProjector> chatTurns;
    private final ObjectProvider<RuntimeEventPublisher> runtimeEvents;
    private final ObjectProvider<InputWakeupService> inputWakeups;
    /** 待收口位的读写口：脚本成功之后由本类自己按 id 条件清 0。 */
    private final ObjectProvider<ExecutionRepository> executions;

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
     * <p><b>两步都是尽力而为</b>：它们各是一份独立信息，且都不会产出「成功结束」这种假结果 ——
     * 卡片没开但轮次标了等待，用户还能靠手动 {@code /resume} 走出来；两步都放弃，轮次会停在
     * 「运行中」，那才是真的走不出来。</p>
     *
     * @param execution 已提交的挂起执行
     */
    public void onSuspended(Execution execution) {
        try {
            readinessService.getObject().markReady(execution.getId());
        } catch (RuntimeException error) {
            log.error("挂起投影失败: executionId={}, step={}", execution.getId(), STEP_RELEASE_CARDS, error);
        }
        try {
            chatTurns.getObject().markExecutionWaiting(execution);
        } catch (RuntimeException error) {
            log.error("挂起投影失败: executionId={}, step={}", execution.getId(), STEP_WAITING_TURN, error);
        }
    }

    /**
     * 终结收口脚本：按因果顺序把各模块收尾走完，必须成功的一步失败就抛。
     *
     * <p><b>顺序不可交换，逐条说明依赖与失败后果</b>：</p>
     * <ol>
     *   <li>{@value #STEP_CLOSE_CARDS}（必须）：先收掉还挂着的询问/审批卡片。失败后果 ——
     *       界面展示一个已结束执行的可点卡片，用户点下去就是对已终结执行做决策；后面每一步
     *       都以「没有待处理卡片」为前提，所以失败必须中断。</li>
     *   <li>{@value #STEP_SUB_EXECUTION_FINISHED}（必须）：子执行结束事实在卡片收口之后。
     *       失败后果 —— 根执行仍被判为「还在等这个子代理」，永远不会收尾，比轮次没收口严重；
     *       因此失败同样中断，不许把子执行所在轮次标成正常结束让用户以为链路走通了。</li>
     *   <li>{@value #STEP_SAVE_USAGE}（必须）：会话上下文占用与轮次用量都按执行快照覆盖写。
     *       失败后果 —— 计费与用量视图永久少这一段；补偿路径上没有框架事件，只有这里会写，
     *       所以它不能是「尽力」。判据是覆盖写，重复执行结果一致。</li>
     *   <li>{@value #STEP_FINISH_TURN}（必须）：业务轮次最后写，它是用户可见的最终状态。
     *       失败后果 —— 轮次永远停在「进行中」，必须由补偿重做。</li>
     * </ol>
     *
     * <p><b>本方法必须早于框架终态事件</b>：框架的顺序是「save(FAILED) → 返回发布任务 → 调用方 run 它」，
     * 业务侧没有排序权，只能在保存提交后、框架发布之前把轮次收口补上；否则界面会先收到终态、
     * 后收到轮次更新，出现「执行结束了但轮次还转着」的瞬间。</p>
     *
     * @param execution 已提交的终态执行
     * @throws ExecutionClosureFailure 必须成功的一步失败（中断后续，待收口位保持 1）
     */
    public void closeTerminal(Execution execution) {
        step(execution, STEP_CLOSE_CARDS,
                () -> toolCallService.getObject().cancelPendingToolCalls(execution.getId()));
        step(execution, STEP_SUB_EXECUTION_FINISHED,
                () -> subExecutionLifecycle.getObject().onFinished(execution));
        step(execution, STEP_SAVE_USAGE, () -> saveUsage(execution));
        step(execution, STEP_FINISH_TURN,
                () -> chatTurns.getObject().finishExecution(execution));
    }

    /**
     * 用量落库：两个口径都按<b>执行自身的权威快照</b>覆盖写，因此重复执行结果一致（不累加）。
     *
     * <ul>
     *   <li>会话侧上下文占用：{@code execution.contextUsageMetric} → 会话的上下文用量列；</li>
     *   <li>轮次侧 token 用量：{@code execution.tokenUsage} → 轮次用量列（覆盖写，{@code null} 不覆盖）。</li>
     * </ul>
     *
     * <p><b>为什么轮次用量也要在这里写一遍</b>：正常路径上框架的终态事件会带 {@code tokenInfo}
     * 让 {@code ChatTurnRuntimeListener} 入账，但<b>补偿路径上没有事件</b> —— 进程重启后框架早已
     * 消失，只有本投影还会被执行一次。若这里不写，崩溃窗口里丢掉的用量就永久缺失，
     * 「会话用量是业务状态」这条约束落不了地。</p>
     *
     * <p>两条写的是同一份事实的不同侧面，同时失败时用步骤名区分不出是谁 —— 因此合并成一个步骤，
     * 失败即中断（不清待收口位、不广播），由补偿重做；重复执行的幂等性由「覆盖写」保证。</p>
     */
    private void saveUsage(Execution execution) {
        sessionUsage.getObject().saveExecutionContextUsage(execution);
        chatTurns.getObject().refreshUsageFromExecution(execution);
    }

    /**
     * 收口补偿入口：重做一条完整脚本，成功则清待收口位，再对外广播/唤醒。
     *
     * <p><b>谁调它</b>：①该执行的下一次 {@code save}（上一次收口失败时重试）；
     * ②{@code ExecutionStartupReaper} 按 {@code closure_pending = 1} 扫出来的行
     * （崩溃落在提交与收口之间时的唯一恢复路径）。</p>
     *
     * <p><b>顺序就是安全性</b>：脚本 → 清位 → 广播 → 唤醒。任何一步失败都不广播、不清位 ——
     * 「已取消」是一次性通知，重发会让订阅方收到两次；而缺失的广播靠轮次终态收敛。
     * 脚本失败只记日志并返回，待收口位仍是 1，等下一次重试。</p>
     *
     * @param execution 需要收口的终态执行
     * @param cancelled 是否取消终态（决定清位后是否补发取消事件）
     */
    public void completeClosure(Execution execution, boolean cancelled) {
        completeClosure(execution, cancelled, false);
    }

    /**
     * 同上，并声明「框架那一次成功终态发布不会再来，需要本入口补发」。
     *
     * <p><b>只有启动收口传 {@code true}</b>：它按 {@code closure_pending = 1} 扫出来的行，
     * 而框架的成功终态在发布时已被通知层门禁拦下（同一列判据），此后再没有人会替它发。
     * 正常路径（{@code save} / {@code unregister} 的 {@code afterCommit}）必须传 {@code false}：
     * 框架紧接着自己会发，这里再发就是重复。</p>
     *
     * <p><b>补发一次且只一次靠库内事实</b>：先读一次待收口位，只有「读到时仍为 1」（说明确实被拦过）
     * 才在清位之后补发；第二遍补偿读到的已是 0，不会再发。不引入内存标记。</p>
     *
     * @param execution                 需要收口的终态执行
     * @param cancelled                 是否取消终态
     * @param compensateTerminalDelivery 是否由本入口补发被拦下的成功终态
     */
    public void completeClosure(Execution execution, boolean cancelled, boolean compensateTerminalDelivery) {
        if (execution == null || execution.getId() == null || !isTerminal(execution.getExecutionState())) {
            // 未到终态的执行没有「收口」可补：替它收口等于替用户做结束决定。
            return;
        }
        // 补发判据在清位之前读：清完之后这一列就是 0，读不出「当初有没有被拦过」。
        boolean terminalDeliverySuppressed = compensateTerminalDelivery && !cancelled && wasPending(execution);
        try {
            closeTerminal(execution);
        } catch (ExecutionClosureFailure failure) {
            log.error("执行收口失败，待收口位保留待重试: executionId={}, step={}, error={}",
                    execution.getId(), failure.step(), failure.getCause() == null
                            ? failure.toString() : failure.getCause().toString(), failure);
            return;
        }
        try {
            executions.getObject().clearClosurePending(numericId(execution.getId()));
        } catch (RuntimeException error) {
            // 清位失败只意味着「下次会再补一遍幂等脚本」，绝不能因此丢掉广播。
            log.error("清除待收口位失败: executionId={}, step={}", execution.getId(), STEP_CLEAR_PENDING, error);
        }
        if (cancelled) {
            try {
                runtimeEvents.getObject().onExecutionCancelled(new ExecutionCancelledEvent(execution.getId(),
                        TokenInfo.from(execution.getTokenUsage()), execution.eventMetaData()));
            } catch (RuntimeException error) {
                log.error("发布取消终态失败: executionId={}, step={}", execution.getId(), STEP_PUBLISH_CANCELLED, error);
            }
        }
        if (terminalDeliverySuppressed) {
            publishCompensatedCompletion(execution);
        }
        resumeInputIfPending(execution);
    }

    /**
     * 补发被通知层门禁拦下的成功终态。
     *
     * <p>只发一次「完成」：失败同样只记日志 —— 客户端靠 bootstrap 与轮次终态快照能收敛到已完成，
     * 而业务事实已经在库里，重试广播没有任何要修复的东西。</p>
     */
    private void publishCompensatedCompletion(Execution execution) {
        try {
            runtimeEvents.getObject().onExecutionComplete(new ExecutionCompleteEvent(execution.getId(),
                    TokenInfo.from(execution.getTokenUsage()), execution.eventMetaData()));
        } catch (RuntimeException error) {
            log.error("补发成功终态失败: executionId={}, step={}", execution.getId(), STEP_PUBLISH_COMPLETED, error);
        }
    }

    /** 只读该执行是否还有待收口事实；读失败按「没有」处理，绝不因此拦掉终态。 */
    private boolean wasPending(Execution execution) {
        try {
            return executions.getObject().isClosurePending(numericId(execution.getId()));
        } catch (RuntimeException error) {
            log.warn("读取待收口位失败，按未拦下处理: executionId={}, error={}",
                    execution.getId(), error.toString());
            return false;
        }
    }

    /** 必须成功的一步：失败包装成带步骤名的异常，中断整条脚本。 */
    private static void step(Execution execution, String name, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException error) {
            log.error("执行收口失败: executionId={}, step={}, error={}",
                    execution == null ? null : execution.getId(), name, error.toString(), error);
            throw new ExecutionClosureFailure(name, error);
        }
    }

    /** 尽力而为的一步：失败只丢这一项信息。 */
    private static void bestEffort(Execution execution, String name, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException error) {
            log.error("执行收口尽力步骤失败: executionId={}, step={}, error={}",
                    execution == null ? null : execution.getId(), name, error.toString(), error);
        }
    }

    /** 终态判据只在这里用一次：application 层不反向依赖 harness 的状态编码器。 */
    private static boolean isTerminal(ExecutionState state) {
        return state == ExecutionState.COMPLETED || state == ExecutionState.FAILED
                || state == ExecutionState.CANCELLED;
    }

    private static long numericId(String executionId) {
        try {
            return Long.parseLong(executionId);
        } catch (NumberFormatException error) {
            throw new IllegalStateException("执行 ID 必须是数字: executionId=" + executionId, error);
        }
    }

    /**
     * 自动唤醒复查：执行停下之后，队列里可能已经有输入在等它。
     *
     * <p>必须放在所有落库动作之后调用：复查读的是落库状态，提前调用会让唤醒基于旧事实判断。</p>
     *
     * @param execution 已提交的执行
     */
    public void resumeInputIfPending(Execution execution) {
        if (execution == null || execution.getId() == null) {
            return;
        }
        bestEffort(execution, STEP_RESUME_PENDING_INPUT,
                () -> inputWakeups.getObject().resumeIfInputPending(numericId(execution.getId())));
    }
}
