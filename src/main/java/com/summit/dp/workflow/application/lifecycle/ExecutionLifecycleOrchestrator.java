package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;

/**
 * 执行生命周期统一编排：启动、暂停、恢复三个动作的唯一入口。
 *
 * <p><b>为什么要收成一个口</b>：暂停/恢复原先散在 {@code ChatServiceImpl}、恢复协调器、
 * 受理执行器、子执行提交器里，门禁条件各写一份，「改了闸门漏掉某条路径」是必然结果。</p>
 */
public interface ExecutionLifecycleOrchestrator {

    /**
     * 跑一次新执行，失败按角色统一收口后原样抛出。
     *
     * @return 执行体返回的执行对象
     */
    Execution submitNewExecution(ExecutionLaunchSpec launchSpec);

    /**
     * 收口一次没能起步的执行（线程池拒绝、子执行落库前失败、崩溃遗留）。
     *
     * <p>与 {@link #submitNewExecution} 分开，是因为这些场景根本没有 body 可包；
     * 收口本身失败只告警，绝不掩盖传入的原始异常。</p>
     */
    void closeFailedStartup(Execution execution, Exception cause, ExecutionLaunchRole role);

    /** 请求暂停某会话下仍在生命周期内的执行；执行刚好结束属于正常竞争，不报错。 */
    void pauseSessionExecution(String sessionId);

    /**
     * 请求恢复挂起执行：所有入口一律经过这里。
     *
     * <p>手动触发在本方法内同步预检并同步恢复（原因要能立刻回给用户）；
     * 其余触发入队，由消费端锁内复检后恢复。</p>
     */
    ResumeAcceptResult requestResume(ResumeRequest request);
}
