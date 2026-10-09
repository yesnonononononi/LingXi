package com.summit.dp.shared.vo.block;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

/** 工具身份来自调用 ID，响应身份与请求位置用于排序，结果以工具视图为准。 */
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
