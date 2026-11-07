package com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.workflow.application.chat.SessionContextEntity;
import com.summit.dp.workflow.application.lifecycle.ExecutionLaunchGateway;
import com.summit.dp.workflow.application.lifecycle.ExecutionLaunchRole;
import com.summit.dp.workflow.application.lifecycle.ExecutionLaunchSpec;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.infrastructure.harness.agent.SubAgent;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.session.SubSessionResolver;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 协作式子执行的<b>专用</b>提交与收尾：把一次异步委派丢进虚拟线程，在里面按固定顺序落库并跑子 loop。
 *
 * <p><b>为什么不复用 {@code PreparedChatExecutor.run}</b>：它的 finally 会 {@code finishRoot}（释放根运行资格）。
 * 异步子执行若借它执行，就会在子执行结束时误释放根资格 —— 根可能还在跑，或已完工而子执行仍在跑。
 * 本类只做子执行该做的事：<b>检查取消 → 建行 / 落账 / 建执行 → 跑 loop → 回写上下文</b>，
 * 全程不碰 {@code beginRoot} / {@code finishRoot}，也不走受理链、不建流。</p>
 *
 * <p>登记早于异步提交，注销只发生在真正终态；挂起仍算未结束，避免根提前收尾。</p>
 */
@Slf4j
@Component
public class AsyncDelegationSubmitter {

    private final SubAgent subAgent;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final SubSessionResolver subSessionResolver;
    private final DelegationRecorder delegationRecorder;
    private final ModelContextService modelContextService;
    private final ExecutionControl executionControl;
    /** 启动失败收口口径的唯一实现；本类只声明自己是子代理启动。 */
    private final StartupFailureCloser startupFailureCloser;
    /** 子执行从未建立执行（落库前失败）时的兜底结束事实协作器。 */
    private final SubExecutionLifecycle subExecutionLifecycle;
    /** 统一启动入口：与根会话共用同一套准入与没能起步的收口。 */
    private final ExecutionLaunchGateway executionLaunchGateway;
    private final ExecutorService executorService = Executors.newVirtualThreadPerTaskExecutor();

    /**
     * 手工构造重载：启动入口用同一个收口口径现装。
     *
     * <p>生产的唯一构造器是下面那个（Spring 注入共享实例）；这个重载只为直接 {@code new} 的用例
     * 保留原来的参数个数。</p>
     */
    public AsyncDelegationSubmitter(SubAgent subAgent,
                                    SessionExecutionRegistry sessionExecutionRegistry,
                                    SubSessionResolver subSessionResolver,
                                    DelegationRecorder delegationRecorder,
                                    ModelContextService modelContextService,
                                    ExecutionControl executionControl,
                                    StartupFailureCloser startupFailureCloser,
                                    SubExecutionLifecycle subExecutionLifecycle) {
        this(subAgent, sessionExecutionRegistry, subSessionResolver, delegationRecorder, modelContextService,
                executionControl, startupFailureCloser, subExecutionLifecycle,
                new ExecutionLaunchGateway(startupFailureCloser));
    }

    /** 生产构造器：由容器注入共享的启动入口。 */
    @Autowired
    public AsyncDelegationSubmitter(SubAgent subAgent,
                                    SessionExecutionRegistry sessionExecutionRegistry,
                                    SubSessionResolver subSessionResolver,
                                    DelegationRecorder delegationRecorder,
                                    ModelContextService modelContextService,
                                    ExecutionControl executionControl,
                                    StartupFailureCloser startupFailureCloser,
                                    SubExecutionLifecycle subExecutionLifecycle,
                                    ExecutionLaunchGateway executionLaunchGateway) {
        if (subAgent == null || sessionExecutionRegistry == null || subSessionResolver == null
                || delegationRecorder == null || modelContextService == null || executionControl == null
                || startupFailureCloser == null || subExecutionLifecycle == null
                || executionLaunchGateway == null) {
            throw new IllegalArgumentException("子执行协作方不能为空");
        }
        this.subAgent = subAgent;
        this.sessionExecutionRegistry = sessionExecutionRegistry;
        this.subSessionResolver = subSessionResolver;
        this.delegationRecorder = delegationRecorder;
        this.modelContextService = modelContextService;
        this.executionControl = executionControl;
        this.startupFailureCloser = startupFailureCloser;
        this.subExecutionLifecycle = subExecutionLifecycle;
        this.executionLaunchGateway = executionLaunchGateway;
    }

    /**
     * 提交一次协作式子执行：走统一启动入口，真正的落库与开跑在角色线程池内进行。
     *
     * <p><b>准入与登记撤销都在统一入口里</b>：准入是抢登记 {@code tryStartChild}，
     * 没能起步时撤销的是子登记 {@code revokeChild} —— 与根会话释放运行资格是两件事，
     * 混用会让还在跑的根被误判为「已收尾」。</p>
     */
    public void submit(AsyncDelegationTask task) {
        launchGateway().submit(childLaunchSpec(task));
    }

    /**
     * 子代理的启动请求：执行对象此时还不存在（{@code createExecution} 在异步体里），
     * 所以提交被拒时只撤销登记，没有执行终态可收 —— 这是角色差异，不是漏实现。
     */
    private ExecutionLaunchSpec childLaunchSpec(AsyncDelegationTask task) {
        Long rootSessionId = task.rootSessionId();
        Long childSessionId = task.numericSubSessionId();
        return new ExecutionLaunchSpec(ExecutionLaunchRole.SUB_AGENT, executorService, null,
                () -> sessionExecutionRegistry.tryStartChild(task.request().getExecutionId()),
                () -> {
                    sessionExecutionRegistry.revokeChild(rootSessionId, childSessionId,
                            task.request().getExecutionId());
                    log.info("子执行未开跑（根已取消）: rootSessionId={}, subSessionId={}",
                            rootSessionId, childSessionId);
                },
                () -> runChild(task));
    }

    /** 统一启动入口：与根会话共用同一个实例。 */
    private ExecutionLaunchGateway launchGateway() {
        return executionLaunchGateway;
    }

    /**
     * 子执行体：准入已在统一入口里过完，这里直接落库并开跑。
     */
    private void runChild(AsyncDelegationTask task) {
        Long rootSessionId = task.rootSessionId();
        Long childSessionId = task.numericSubSessionId();
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
            log.warn("异步子执行失败: rootSessionId={}, subSessionId={}", rootSessionId, childSessionId, e);
            // 子执行从未建立执行（无生命周期通知）时的结束事实：移除登记 + 唤醒根；已开跑的失败走框架
            // notifyFinished 链，二者幂等。
            subExecutionLifecycle.abandonChild(rootSessionId, childSessionId, task.request().getExecutionId(), task.rootExecutionId());
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
            closeFailedChildStartup(created, e);
            throw e;
        }
    }

    /**
     * 未开跑的子执行收口。
     *
     * <p>口径交给 {@code StartupFailureCloser}（SUB_AGENT 角色）：框架已 fail 过的因终态被跳过，
     * 在这个类里再判一遍状态就是第二份口径，改一处漏一处。</p>
     */
    private void closeFailedChildStartup(Execution execution, RuntimeException cause) {
        startupFailureCloser.closeQuietly(execution, cause, ExecutionLaunchRole.SUB_AGENT);
    }

    /** 关闭时停掉子执行线程池，避免非托管场景下的线程泄漏。 */
    @PreDestroy
    public void close() {
        executorService.shutdownNow();
    }
}
