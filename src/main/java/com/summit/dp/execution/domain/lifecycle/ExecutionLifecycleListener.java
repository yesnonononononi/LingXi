package com.summit.dp.execution.domain.lifecycle;

/**
 * 执行生命周期端口：execution 模块在 loop 边界发出「挂起 / 终结」信号，
 * 由关心工具调用卡片生命周期的上层（toolcall）订阅并驱动。
 *
 * <p><b>为什么需要端口（评审 P1-⑥）：</b>执行仓储（infrastructure）本应只依赖自身 domain，
 * 原先却直接注入工具调用应用服务（application），形成 {@code execution.infrastructure → toolcall.application}
 * 的反向依赖并用 {@code ObjectProvider} 规避构造期环。定义本端口后，
 * {@code LocalExecutionRepository} 只持有 {@link ExecutionLifecycleListener} 列表并广播信号，
 * 具体「推送 pending 卡片 / 收尾残留卡片」由 toolcall 侧的适配器实现，反向依赖被切断。</p>
 */
public interface ExecutionLifecycleListener {

    /** loop 边界：执行进入挂起态——可能有待人工审批的工具调用卡片需要推送。 */
    void onExecutionSuspended(String executionId);

    /** loop 边界：执行进入终态（完成 / 失败 / 取消）——需收尾该执行下残留的待处理卡片。 */
    void onExecutionFinished(String executionId);
}
