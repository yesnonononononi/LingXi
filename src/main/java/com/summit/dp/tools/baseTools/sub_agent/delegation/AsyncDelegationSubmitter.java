package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.agent.infrastructure.agent.SubAgent;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
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
 * 本类只做子执行该做的事：<b>注册 → 建行 / 落账 / 建执行 → 跑 loop → 回写上下文 → 注销</b>，
 * 全程不碰 {@code beginRoot} / {@code finishRoot}，也不走受理链、不建流。</p>
 *
 * <p><b>注册时机</b>：子执行比工具调用活得久，注册必须跟着子执行自身的生命周期，而不是工具调用的 try/finally。
 * 因此注册落在 {@link #runChild} 的方法体内、子 loop 开跑<b>之前</b>，注册对象是<b>该异步线程自身</b>
 * （{@code Thread.currentThread()} 才是 {@code interrupt} 打得到的那根线程），注销挂在它的 finally。
 * 「先注册成功、再做其余全部落库 / 开跑动作」保证「提交后、开跑前被取消」这一窗口不产生任何孤儿。</p>
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
    private final ExecutorService executorService = Executors.newVirtualThreadPerTaskExecutor();

    /** 提交一次协作式子执行：立即返回，真正的落库与开跑在虚拟线程内进行。 */
    public void submit(AsyncDelegationTask task) {
        CompletableFuture.runAsync(() -> runChild(task), executorService);
    }

    /**
     * 子执行体：与阻塞路径同构且同序 —— 先注册，再落库，最后开跑。
     *
     * <p>注册失败意味着根已停止：此时<b>不建任何行、不开跑</b>，直接结束（无孤儿）。</p>
     */
    private void runChild(AsyncDelegationTask task) {
        Long rootSessionId = task.rootSessionId();
        Long childSessionId = task.numericSubSessionId();

        if (!sessionExecutionRegistry.registerChild(rootSessionId, childSessionId, Thread.currentThread())) {
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

            // 二期预留点：此处投递交付邮件，并判定收件方（主理人）是否已完工 → 已完工则新建执行唤醒。
            // 一期不实现（PRD P2-1 / P2-3），只留位置。
        } catch (RuntimeException e) {
            log.warn("异步子执行失败: rootSessionId={}, subSessionId={}, cause={}",
                    rootSessionId, childSessionId, e.toString());
            // 二期预留点：失败也走邮件投递（P2-3）。一期不实现。
        } finally {
            sessionExecutionRegistry.unregisterChild(rootSessionId, childSessionId);
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
