package com.summit.dp.shared.vo.block;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * 文本块：一轮模型调用的一段正文（粒度 = 该次响应的文本，最多一块）。
 *
 * <p>状态来自响应生命周期，落点见 {@link Placement}（由后端按「该轮是否含工具请求」判定）。</p>
 */
public record TextBlock(
        @JsonProperty("blockId") String blockId,
        @JsonProperty("responseId") String responseId,
        @JsonProperty("order") int order,
        @JsonProperty("status") String status,
        @JsonProperty("placement") Placement placement,
        @JsonProperty("text") String text
) implements Block {

    /** 身份规则：{@code text:<responseId>}。 */
    public static String identity(String responseId) {
        return "text:" + responseId;
    }

    @Override
    public String getBlockId() {
        return blockId;
    }

    @Override
    @JsonIgnore
    public String getType() {
        return TYPE_TEXT;
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
