package com.summit.dp.toolcall.application.service;

import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;

/**
 * 唯一写入登记器：{@code tool_call} 表**只由它写入**。
 *
 * <p><b>职责边界：</b>本接口被工具 executor（{@code CreatePlanTool}）与命令策略依赖，
 * 因此**不得**注入 {@code ExecutionControl} / {@code IChatAgent}（否则构造期闭环）；
 * 只有 {@link ToolCallService} 才持有那些重量级依赖。</p>
 *
 * <p><b>幂等 / 最后写入者胜出：</b>同一 call id 只对应一行；PROMISE 登记会覆盖升级
 * EXECUTE 占位行（见 {@link #registerPromise}）。</p>
 */
public interface ToolCallRegistrar {

    /**
     * PROMISE 登记：命中已有行则**升级**为 {@code PROMISE/pending}（覆盖 EXECUTE 占位），否则插入。
     *
     * @return 工具调用 id
     */
    String registerPromise(ToolCallRegisterCommand cmd);

    /**
     * EXECUTE 开始：不存在则插入 {@code EXECUTE/in_progress}；已存在（含 PROMISE）则 no-op。
     */
    void markExecuteStarted(String toolCallId, long executionId, String toolName, String argsJson);

    /**
     * EXECUTE 结束：命中且为 EXECUTE 则 complete + 写 {@code raw_output}；
     * 命中 PROMISE 则 no-op（交给 {@link ToolCallService#decide} 收尾）；缺失则兜底插入 completed。
     */
    void completeExecute(String toolCallId, long executionId, String toolName, String argsJson,
                         String output, ToolCallOutcome outcome);
}
