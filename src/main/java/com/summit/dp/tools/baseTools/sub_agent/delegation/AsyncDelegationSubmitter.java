package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.runtime.SubExecutionLifecycle;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.context.SessionContextEntity;
import com.summit.dp.tools.baseTools.sub_agent.session.SubSessionResolver;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 协作式子执行的<b>专用</b>提交与收尾：把一次异步委派丢进虚拟线程，在里面按固定顺序落库并跑子 loop。
 *
 * <p><b>为什么不复用 {@code PreparedChatExecutor.run}</b>：它的 finally 会 {@code finishRoot}（释放根运行资格）。
 * 异步子执行若借它执行，就会在子执行结束时误释放根资格 —— 根可能还在跑，或已完工而子执行仍在跑。
 * 本类只做子执行该做的事：<b>绑定运行线程 → 建行 / 落账 / 建执行 → 跑 loop → 回写上下文</b>，
 * 全程不碰 {@code beginRoot} / {@code finishRoot}，也不走受理链、不建流。</p>
 *
 * <p><b>登记与注销都在子执行自身生命周期上</b>：「待启动」登记由提交方（{@code CallSubAgentTool}）
 * 在提交前完成，本类在子 loop 开跑<b>之前</b>把登记绑定到该异步线程自身（{@code Thread.currentThread()}
 * 才是 {@code interrupt} 打得到的那根线程）；注销<b>不再</b>挂在异步线程的 finally —— 挂起的子执行
 * 仍算「未结束」，只有真正终态才由结束事实链（{@code SubExecutionLifecycle}）移除，避免根在子执行
 * 等待人工审批期间被误判为「无子执行」而提前收尾。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AsyncDelegationSubmitter {

    private final SubAgent subAgent;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final SubSessionResolver subSessionResolver;
    private final DelegationRecorder delegationRecorder;
    private final ModelContextService modelContextService;
    private final ExecutionControl executionControl;
    /** 子执行从未建立执行（落库前失败）时的兜底结束事实协作器。 */
    private final SubExecutionLifecycle subExecutionLifecycle;
    private final ExecutorService executorService = Executors.newVirtualThreadPerTaskExecutor();

    /** 提交一次协作式子执行：立即返回，真正的落库与开跑在虚拟线程内进行。 */
    public void submit(AsyncDelegationTask task) {
        CompletableFuture.runAsync(() -> runChild(task), executorService);
    }

    /**
     * 子执行体：先绑定运行线程，再落库，最后开跑。
     *
     * <p>绑定失败意味着根已取消：此时<b>不建任何行、不开跑</b>，撤销未开跑登记后直接结束（无孤儿）。</p>
     */
    private void runChild(AsyncDelegationTask task) {
        Long rootSessionId = task.rootSessionId();
        Long childSessionId = task.numericSubSessionId();

        if (!sessionExecutionRegistry.bindRunningChild(rootSessionId, childSessionId, Thread.currentThread())) {
            sessionExecutionRegistry.revokeChild(rootSessionId, childSessionId);
            log.info("子执行未开跑（根已取消）: rootSessionId={}, subSessionId={}", rootSessionId, childSessionId);
            return;
        }
        try {
            // 首次委派才建会话行；复用路径行已存在，重复 insert 会主键冲突。
            if (!task.target().reused()) {
                subSessionResolver.createSubSession(childSessionId, rootSessionId, task.parentWorkspaceId(),
                        task.agent(), task.argument().getTask());
            }

            delegationRecorder.record(rootSessionId, task.toolExecution(), task.request(),
                    childSessionId, task.target().subSessionId(), task.agent(), task.argument().getTask());

            Execution execution = SessionContextEntity.runWithSubSession(rootSessionId, task.agent().getId(),
                    () -> createAndRun(task));

            modelContextService.replace(childSessionId, execution.getMessages());
        } catch (RuntimeException e) {
            log.warn("异步子执行失败: rootSessionId={}, subSessionId={}, cause={}",
                    rootSessionId, childSessionId, e.toString());
            // 子执行从未建立执行（无生命周期通知）时的结束事实：移除登记 + 唤醒根；已开跑的失败走框架
            // notifyFinished 链，二者幂等。
            subExecutionLifecycle.abandonChild(rootSessionId, childSessionId, task.rootExecutionId());
        }
    }

    /**
     * 在子代理上下文中建执行并跑 loop。
     *
     * <p>建执行用框架 {@code SubAgent.createExecution(request)}（只登记不运行），<b>不走</b>受理链 ——
     * 轮次与用户消息已由 {@code DelegationRecorder} 落好，再走一遍会重复建轮次、重复写用户消息。</p>
     *
     * <p>只有 {@code CREATED} 态的失败才需要业务侧补收口：框架入口内与 loop 内的失败它已自行 fail 过，
     * 重复 fail 会抛非法状态转换（与 {@code PreparedChatExecutor} 的判据同口径）。</p>
     */
    private Execution createAndRun(AsyncDelegationTask task) {
        Execution created = subAgent.createExecution(task.request());
        try {
            return subAgent.execute(created);
        } catch (RuntimeException e) {
            failCreatedExecutionQuietly(created, e);
            throw e;
        }
    }

    private void failCreatedExecutionQuietly(Execution execution, RuntimeException cause) {
        if (execution == null || execution.getExecutionState() != ExecutionState.CREATED) {
            return;
        }
        try {
            executionControl.fail(execution, cause).run();
        } catch (RuntimeException failFailure) {
            log.warn("收口未开跑的子执行时出错: executionId={}, cause={}, 收口失败原因={}",
                    execution.getId(), cause.toString(), failFailure.toString());
        }
    }

    /** 关闭时停掉子执行线程池，避免非托管场景下的线程泄漏。 */
    @PreDestroy
    public void close() {
        executorService.shutdownNow();
    }
}
