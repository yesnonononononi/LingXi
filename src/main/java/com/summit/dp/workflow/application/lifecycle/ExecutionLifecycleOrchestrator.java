package com.summit.dp.workflow.application.lifecycle;

/**
 * 执行生命周期统一编排：暂停与恢复两个动作的唯一入口。
 *
 * <p><b>为什么要收成一个口</b>：暂停/恢复原先散在 {@code ChatServiceImpl}、恢复协调器、
 * 受理执行器、子执行提交器里，门禁条件各写一份，「改了闸门漏掉某条路径」是必然结果。</p>
 *
 * <p><b>启动失败收口与统一启动入口都不在这里</b>：收口口径由 {@link StartupFailureCloser} 按角色提供，
 * 启动本身由 {@link ExecutionLaunchGateway} + {@link ExecutionLaunchSpec} 承担（角色差异写在
 * {@link ExecutionLaunchRole} 里）。本接口只管暂停与恢复两个动作 —— 曾在此留过一层
 * {@code submitNewExecution} / {@code closeFailedStartup} 包装，生产代码一个都没走，已删。</p>
 */
public interface ExecutionLifecycleOrchestrator {

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
