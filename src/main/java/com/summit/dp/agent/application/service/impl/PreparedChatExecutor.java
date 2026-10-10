package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.utils.RequestPreparer;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 受理与执行协作：受理把轮次、用户消息与执行行一次提交；执行阶段只跑模型。
 *
 * <p><b>为什么两段要分开</b>：异常发生时必须能判断该回「受理失败」还是「执行失败」——
 * 前者要保留输入让用户重发，后者输入已生效、只需展示失败。混在一个方法里就失去这个判据。</p>
 *
 * <p><b>收尾纪律</b>：运行资格（{@link SessionExecutionRegistry#finishRoot}）由本类在
 * {@code finally} 释放 —— 它必须覆盖模型调用的完整生命周期，否则一次模型异常就把会话
 * 永久锁死在「执行中」，用户再也发不出第二条消息。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PreparedChatExecutor {

    private final AgentWorkflowOrchestrator agentWorkflowOrchestrator;
    private final RequestPreparer requestPreparer;
    private final ModelContextService modelContextService;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ExecutionControl executionControl;
    private final ExecutorService executorService = Executors.newVirtualThreadPerTaskExecutor();

    /**
     * 受理：把业务轮次、用户消息与框架执行行放进同一个事务提交。
     *
     * <p><b>为什么事务根在这里</b>：执行行由框架创建（{@code Agent.createExecution}），而构建执行请求要经
     * 编排器（它又依赖 {@link RequestPreparer}），只有本类能同时持有两者而不构成循环依赖。
     * 也正因为要经过代理，本方法**必须由其他 bean 调用**：内联进 {@code ChatServiceImpl} 会让
     * {@code @Transactional} 静默失效、原子性无声丢失。</p>
     *
     * <p><b>顺序不可交换</b>：创建执行必须在 {@code acceptTurn} 之后 —— 轮次 ID 会写进执行请求的事件
     * 元数据，先建执行会让本轮的 SSE 事件带上空 turnId。</p>
     *
     * <p><b>失败语义</b>：本方法抛出的异常一律是<b>受理失败</b>（整体回滚，三表都不留记录），
     * 与执行阶段的失败严格区分。</p>
     */
    @Transactional
    public RuntimeContext admit(RuntimeContext context) {
        if (context == null || context.pendingUserMessage() == null) {
            return context;
        }
        Long turnId = requestPreparer.commitUserMessage(context);
        RuntimeContext committed = context.withTurnId(turnId);
        return committed.withExecution(agentWorkflowOrchestrator.createExecution(committed));
    }

    /**
     * 异步提交一次已受理的执行：只跑模型，不建 emitter、不订阅。
     *
     * <p><b>提交本身失败（线程池拒绝）与启动失败同口径收口</b>：此时执行从未进入
     * {@link #run}，它的 {@code finally} 不会执行，运行资格与轮次收口必须在这里补上 ——
     * 否则会话被单飞锁死（用户再也发不出下一条），「已受理」的轮次永远没有终态。</p>
     */
    public void submitAsync(RuntimeContext context) {
        try {
            CompletableFuture.runAsync(() -> run(context),executorService);
        } catch (RuntimeException submitFailure) {
            failSubmit(context, submitFailure);
            throw submitFailure;
        }
    }

    /**
     * 提交失败收口：与启动失败同口径把执行 / 轮次收成终态并广播，再释放运行资格。
     *
     * <p><b>本方法不外抛</b>：它只做「收口 + 释放资格」，执行侧收口失败也只告警
     * （见 {@code markStartupFailedQuietly}）。原始的「线程池已满」必须原样冒泡给调用方 ——
     * 那由 {@link #submitAsync} 的 catch 在本方法<b>返回之后</b>抛出，不在这里被换成次生异常。</p>
     *
     * <p>包可见：线程池拒绝难以在单测里稳定复现，暴露这一小步让「拒绝 → 释放资格 + 收口」
     * 这条被漏掉就会锁死会话的路径可被直接验证。这是刻意设计的可测性取舍，
     * 调用方只有 {@link #submitAsync}，不要从别处直接调它。</p>
     */
    void failSubmit(RuntimeContext context, RuntimeException submitFailure) {
        markStartupFailedQuietly(context, submitFailure);
        sessionExecutionRegistry.finishRoot(context.executionContext().rootSessionId());
    }

    /**
     * 跑完一次已受理的执行。
     *
     * <p><b>调用前置</b>：运行资格已由受理脚本通过 {@code beginRoot} 拿到，轮次、用户消息与执行行
     * 已同事务落库。本方法不重复提交、不重复校验单飞 —— 那些都在受理阶段完成了。</p>
     *
     * <p><b>校验必须在 try 内</b>：执行对象缺失时若在 try 之外抛，{@code finally} 不执行、
     * 运行资格不释放，会话被永久锁死。</p>
     *
     * @param context 已带 turnId 与 execution 的上下文
     * @return 本次执行的框架对象（同步入口要拿它的消息集合作返回值）
     */
    public Execution run(RuntimeContext context) {
        long rootSessionId = context.executionContext().rootSessionId();
        try {
            Execution execution = context.execution();
            if (execution == null) {
                throw new IllegalStateException("执行未登记：受理事务必须先创建执行");
            }
            Execution result = agentWorkflowOrchestrator.execute(context, execution);
            modelContextService.replace(ExecutionIdentity.sessionId(result), result.getMessages());
            return result;
        } catch (RuntimeException e) {
            markStartupFailedQuietly(context, e);
            throw e;
        } finally {
            sessionExecutionRegistry.finishRoot(rootSessionId);
        }
    }

    /**
     * 收口「已登记但没能跑起来」的执行；收口本身失败只告警，绝不掩盖原始异常。
     *
     * <p><b>为什么只判状态、别的都不做</b>：执行行与轮次的收口、以及终态事件的发布，
     * 全由框架的 {@code ExecutionControl.fail} 一条链完成 —— 它先落库（终态 + 结束时间），
     * 再由仓储在提交后通知轮次收口，最后才发布事件。业务侧再手工写一遍轮次就会与它打架。</p>
     *
     * <p><b>为什么必须先判状态</b>：框架入口内与 loop 内的失败，框架已自行 fail 过
     * （{@code ChatAgent#execute} 与 {@code RuntimeProcessorTemplate}），而
     * {@code Execution.failChecked} 对已终态会抛「非法状态转换」。判据与旧的 SQL 条件更新同口径：
     * 只处理 CREATED / RUNNING —— 终态不覆盖，挂起更不覆盖（挂起可恢复）。</p>
     */
    private void markStartupFailedQuietly(RuntimeContext context, RuntimeException cause) {
        Execution execution = context.execution();
        if (execution == null) {
            return;
        }
        try {
            ExecutionState state = execution.getExecutionState();
            if (ExecutionStatusCodes.isTerminalState(state) || state == ExecutionState.SUSPENDED) {
                return;
            }
            executionControl.fail(execution, cause).run();
        } catch (RuntimeException failFailure) {
            log.warn("收口启动失败的执行时出错: executionId={}, cause={}, 收口失败原因={}",
                    execution.getId(), cause.toString(), failFailure.toString());
        }
    }

    /** 关闭时停掉执行线程，避免非托管场景下的线程泄漏。 */
    @PreDestroy
    public void close() {
        executorService.shutdownNow();
    }
}
