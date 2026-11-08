package com.summit.dp.workflow.application.lifecycle;

import com.summit.dp.execution.application.service.ResumeDisposition;

/**
 * 恢复受理端口：决策、输入唤醒只通过它登记恢复，不再直连协调器。
 *
 * <p><b>事务契约</b>：调用方<b>必须在自己的事务内调用</b>。请求行写 {@code execution_resume_task}
 * 与调用方的决策结论、槽位回填、模型上下文同批提交 —— 于是不存在「决策已落库、恢复请求没落库」
 * 的窗口，也不存在反过来「请求在、决策没在」的窗口。调用方没有事务时（直调路径与单测），
 * 请求行立即写入，由调用方自己承担原子性。</p>
 *
 * <p><b>本端口不做派发以外的任何编排</b>：执行态、未决槽位、代际、控制槽位这些门禁只在
 * {@link ExecutionResumeCoordinator} 一处判定。端口里再判一遍会造出第二套口径，
 * 用户看到的错误就取决于谁先抛断。</p>
 *
 * <p><b>派发在提交之后</b>：受理只落请求行与登记落定回调，真正的唤醒排在事务提交之后，
 * 恢复因此不会读到未提交的槽位状态。</p>
 */
public interface ResumeAcceptancePort {

    /**
     * 受理一次恢复请求（无落定回调）。
     *
     * @param executionId 执行 ID；0 表示没有可用执行（如命令卡片未挂执行）
     * @param trigger     触发来源；决定消费端复检时哪些门禁对它生效，随请求行一起落库
     * @return 恢复处置结论，供回执直接下发
     */
    ResumeDisposition accept(long executionId, ResumeTriggerType trigger);

    /**
     * 受理一次恢复请求并登记「恢复已落定」回调。
     *
     * <p>落定包含全部结局：成功、被取代、门禁暂缓、启动失败、中断、派发被拒。回调恰好执行一次，
     * 且不参与恢复主流程的错误传播 —— 少报任何一种都会让调用方（如 v1 的 SSE）挂着永不结束。</p>
     *
     * @param executionId 执行 ID
     * @param trigger     触发来源
     * @param onSettled   落定回调；可为 {@code null}
     * @return 恢复处置结论
     */
    ResumeDisposition accept(long executionId, ResumeTriggerType trigger, Runnable onSettled);
}
