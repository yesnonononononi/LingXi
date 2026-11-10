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
        @JsonProperty("minusLines") Integer minusLines,
        @JsonProperty("version") Long version,
        /**
         * 该次编辑在文件中的行号区间：{@code 0} 表示该侧不存在（纯插入无旧行、纯删除无新行）。
         *
         * <p>来自 {@code tool_call.meta_data._meta.fileEdit}。**历史消息能不能按行渲染 diff
         * 全靠它** —— 只在事件里带一次的话，刷新之后位置信息就永久丢了。</p>
         */
        @JsonProperty("oldStartLine") Integer oldStartLine,
        @JsonProperty("oldEndLine") Integer oldEndLine,
        @JsonProperty("newStartLine") Integer newStartLine,
        @JsonProperty("newEndLine") Integer newEndLine,
        /** 对应的文件编辑记录标识（按需取差异用）；非编辑工具为空。 */
        @JsonProperty("fileRecordId") String fileRecordId
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
