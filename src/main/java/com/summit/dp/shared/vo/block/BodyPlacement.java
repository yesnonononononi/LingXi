package com.summit.dp.shared.vo.block;

import com.summit.core.conversation.api.ToolCallRequest;

import java.util.List;

/**
 * 正文归属判定 —— 实时与历史共用的唯一规则。
 *
 * <p>{@code isBody} 只表达展示位置；执行是否结束由轮次/执行状态另行表达，不用它承载。</p>
 */
public final class BodyPlacement {

    private BodyPlacement() {
    }

    /**
     * @param requests           该条模型响应的工具请求；{@code null} 或空表示未请求工具
     * @param concluding         该响应是否为所在轮次的最后一条模型响应
     * @param executionCompleted 所在轮次是否正常完成（{@code COMPLETED}）
     */
    public static boolean resolve(List<ToolCallRequest> requests, boolean concluding, boolean executionCompleted) {
        return (requests == null || requests.isEmpty()) && concluding && executionCompleted;
    }
}
