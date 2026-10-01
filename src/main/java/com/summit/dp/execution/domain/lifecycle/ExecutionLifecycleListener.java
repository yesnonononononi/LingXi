package com.summit.dp.execution.domain.lifecycle;

import com.summit.core.agent.Execution;

/**
 * 执行生命周期端口：execution 模块在 loop 边界发出「挂起 / 终结」信号，
 * 由关心执行生命周期上层（toolcall / session / turn）订阅并驱动。
 *
 * <p><b>为什么需要端口（评审 P1-⑥）：</b>执行仓储（infrastructure）本应只依赖自身 domain，
 * 原先却直接注入工具调用应用服务（application），形成 {@code execution.infrastructure → toolcall.application}
 * 的反向依赖并用 {@code ObjectProvider} 规避构造期环。定义本端口后，
 * {@code LocalExecutionRepository} 只持有 {@link ExecutionLifecycleListener} 列表并广播信号，
 * 具体响应由各模块的适配器实现，反向依赖被切断。</p>
 *
 * <p><b>为什么终态信号携带 {@link Execution} 对象：</b>广播点（{@code unregister}）本来就已经
 * {@code findById} 把已落库的执行读回内存——此时框架 loop 在 finally 里填充的
 * {@code contextUsageMetric} 已经进快照并可读。把现成对象随信号递出去，
 * 订阅方（如会话的上下文用量回写）就**不必再反序列化一次 LONGTEXT snapshot**；
 * 「取消挂起中的执行」路径没有 metric（不经 loop），订阅方按 null 降级。</p>
 */
public interface ExecutionLifecycleListener {

    /** loop 边界：执行进入挂起态——可能有待人工审批的工具调用卡片需要推送。 */
    void onExecutionSuspended(String executionId);

    /**
     * loop 边界：执行进入终态（完成 / 失败 / 取消）。
     *
     * <p>{@code execution} 是广播点已加载的已落库执行对象：终态、结束时间与
     * {@code contextUsageMetric}（loop 结束填充，失败路径同样有值）均已就绪；
     * 「取消挂起中的执行」路径未经过 loop，{@code contextUsageMetric} 为 null。</p>
     */
    void onExecutionFinished(String executionId, Execution execution);
}
