package com.summit.dp.shared.vo.block;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

/**
 * 一轮展示里的最小可更新单元（后端唯一定义身份、顺序与状态）。
 *
 * <p><b>为什么块必须有稳定身份</b>：前端只做「按 ID 更新与展示」。身份不稳定（例如靠内容指纹、
 * 靠数组下标）时，一次对账或重连就会把同一段内容认成两个块，或把两个块认成一个。
 * 因此每个块的身份由后端在装配阶段一次定死，历史查询与 SSE 共用同一套身份 ——
 * 两条链路各自造身份，前端就得写两套对账逻辑，那正是本次要收掉的东西。</p>
 *
 * <p><b>identity 规则</b>（后端唯一真源）：</p>
 * <ul>
 *   <li>思考块：{@code thinking:<responseId>} —— 已落库的旧数据用 {@code thinking:message:<行ID>}；</li>
 *   <li>文本块：{@code text:<responseId>} —— 已落库的旧数据用 {@code text:message:<行ID>}；</li>
 *   <li>工具块：{@code tool:<toolCallId>}。</li>
 * </ul>
 * 旧数据没有响应身份，但持久化行 ID 是稳定的，因此**保持 {@code responseId=null} 的同时块仍可稳定定位** ——
 * 不伪造一个假身份，也不用内容去重。
 *
 * <p><b>序列化边界</b>：{@code type} 既是块类型判别键，也是 JSON 多态判别键（{@link JsonTypeInfo}）。
 * 未知类型必须**明确失败**（由 {@code FAIL_ON_INVALID_SUBTYPE} 约束），
 * 因此不声明 {@code defaultImpl} —— 声明了就会把未知类型静默转成某个子类型，
 * 那正是本契约明确禁止的降级。</p>
 */
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

    /** 本轮模型调用身份；思考、文本和工具共享它，旧数据可以缺失。 */
    String getResponseId();

    /** 响应内展示位置；新数据先比较 responseId，旧 UUID 历史仍按原序号。 */
    int getOrder();

    /** 块自身状态，取自各自权威来源（见各实现类）。 */
    String getStatus();
}
