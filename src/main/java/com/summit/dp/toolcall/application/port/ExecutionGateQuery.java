package com.summit.dp.toolcall.application.port;

import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy.ExecutionGate;

/** 卡片只消费执行可用性结论，不接触框架检查点和控制信号。 */
public interface ExecutionGateQuery {
    boolean isActive(String executionId);
    ExecutionGate resolveGate(String executionId);
}
