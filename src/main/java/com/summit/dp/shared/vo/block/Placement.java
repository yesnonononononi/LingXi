package com.summit.dp.shared.vo.block;

import com.summit.core.conversation.api.ToolCallRequest;

import java.util.List;

/** 模型请求结构确定后才能判定用途，实时与历史共用同一规则。 */
public enum Placement {
    /** 结论正文：展示在回答气泡主体里。 */
    BODY,
    /** 中途叙述：展示在可折叠的过程时间线里。 */
    PROCESS;

    /** 实时与历史只依据模型请求结构，不能依据工具执行结果猜用途。 */
    public static Placement resolve(List<ToolCallRequest> requests) {
        return requests == null || requests.isEmpty() ? BODY : PROCESS;
    }
}
