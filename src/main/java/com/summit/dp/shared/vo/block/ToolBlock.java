package com.summit.dp.shared.vo.block;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * 工具块：一次工具调用（粒度 = 一个 toolCall）。
 *
 * <p><b>状态来自权威工具视图</b>（{@code tool_call} 行 + 结果的结论），而不是展示侧的推断。
 * {@link BlockStatus#TOOL_COMPLETED} 只表示**已收尾**，成功/被拒/取消/超时的结论在结果里，
 * 由 {@code ToolCallStatus} 表达（见 {@link BlockStatus} 的说明）。</p>
 *
 * <p>{@code responseId} 恒为 {@code null}：工具块的身份是 {@code toolCallId}，
 * 与模型调用身份无关。{@code order} 取**模型请求顺序**（{@code onAfterModelInvoke} 登记的
 * 工具请求列表），不是工具完成顺序 —— 完成顺序受并发调度影响，无法还原模型原本的意图顺序。</p>
 */
public record ToolBlock(
        @JsonProperty("blockId") String blockId,
        @JsonProperty("responseId") String responseId,
        @JsonProperty("order") int order,
        @JsonProperty("status") String status,
        @JsonProperty("toolCallId") String toolCallId,
        @JsonProperty("toolName") String toolName,
        @JsonProperty("arguments") String arguments,
        @JsonProperty("output") String output,
        @JsonProperty("plusLines") Integer plusLines,
        @JsonProperty("minusLines") Integer minusLines
) implements Block {

    /** 身份规则：{@code tool:<toolCallId>}。 */
    public static String identity(String toolCallId) {
        return "tool:" + toolCallId;
    }

    @Override
    public String getBlockId() {
        return blockId;
    }

    @Override
    @JsonIgnore
    public String getType() {
        return TYPE_TOOL;
    }

    @Override
    public String getResponseId() {
        return responseId;
    }

    @Override
    public int getOrder() {
        return order;
    }

    @Override
    public String getStatus() {
        return status;
    }
}
