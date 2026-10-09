package com.summit.dp.shared.vo.block;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/** 块身份与响应位置由后端确定，历史和实时共用；未知类型必须明确失败。 */
@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "type")
@JsonSubTypes({
        @JsonSubTypes.Type(value = ThinkingBlock.class, name = Block.TYPE_THINKING),
        @JsonSubTypes.Type(value = TextBlock.class, name = Block.TYPE_TEXT),
        @JsonSubTypes.Type(value = ToolBlock.class, name = Block.TYPE_TOOL)
})
public interface Block {
    String TYPE_THINKING = "THINKING";
    String TYPE_TEXT = "TEXT";
    String TYPE_TOOL = "TOOL";

    /** 稳定身份：历史与实时共用，前端据此更新。 */
    String getBlockId();

    /** 块类型，同时作为 JSON 多态判别键。 */
    String getType();

    /** 本轮模型调用身份；思考、文本和工具共享它。 */
    String getResponseId();

    /** 响应内展示位置；先比较 responseId，再比较响应内位置。 */
    int getOrder();

    /** 块自身状态，取自各自权威来源（见各实现类）。 */
    String getStatus();
}
