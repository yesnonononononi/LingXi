package com.summit.dp.shared.vo.block;

import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * 思考块：一轮模型调用的一段思考（粒度 = 该次响应的思考，最多一块）。
 *
 * <p>状态来自响应生命周期：流式中 {@link BlockStatus#STREAMING}，响应完整后 {@link BlockStatus#COMPLETE}。</p>
 */
public record ThinkingBlock(
        @JsonProperty("blockId") String blockId,
        @JsonProperty("responseId") String responseId,
        @JsonProperty("order") int order,
        @JsonProperty("status") String status,
        @JsonProperty("text") String text
) implements Block {

    /** 身份规则：{@code thinking:<responseId>}。 */
    public static String identity(String responseId) {
        return "thinking:" + responseId;
    }

    /** 旧数据身份规则：无响应身份时用持久化行 ID 稳定定位（不伪造身份）。 */
    public static String legacyIdentity(long messageRowId) {
        return "thinking:message:" + messageRowId;
    }

    @Override
    public String getBlockId() {
        return blockId;
    }

    @Override
    @JsonIgnore
    public String getType() {
        return TYPE_THINKING;
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
