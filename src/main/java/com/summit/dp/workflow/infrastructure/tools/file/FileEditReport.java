package com.summit.dp.workflow.infrastructure.tools.file;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;

import java.io.Serializable;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 一次改动的对外结果：模型只收摘要，全文留给前端按 {@code recordId} 现取。
 *
 * <p>元数据只下行号与计数，绝不带正文 —— 正文会击穿 SSE 单帧预算。</p>
 */
public record FileEditReport(FileMutation mutation, DiffResult diff, Serializable recordId) {

    public int plusLines() {
        return diff == null ? 0 : diff.plusLines();
    }

    public int minusLines() {
        return diff == null ? 0 : diff.minusLines();
    }

    /** 模型侧摘要：差异不可用时带原因，而不是把 0 当真。 */
    public Summary summary() {
        if (diff == null) {
            return new Summary(mutation.filePath(), mutation.created(), null, null, "diff unavailable");
        }
        if (!diff.isSuccess()) {
            return new Summary(mutation.filePath(), mutation.created(), null, null, diff.getErrMsg());
        }
        return new Summary(mutation.filePath(), mutation.created(), plusLines(), minusLines(), null);
    }

    /** 随工具结束事件广播的元数据：正文禁入，只给定位标识与行号。 */
    public Map<String, Object> metadata() {
        Map<String, Object> fileEdit = new LinkedHashMap<>();
        fileEdit.put("filePath", mutation.filePath());
        if (recordId != null) {
            fileEdit.put("recordId", String.valueOf(recordId));
        }
        fileEdit.put("plusLines", plusLines());
        fileEdit.put("minusLines", minusLines());
        // 行号从 1 起，0 表示该侧不存在：前端据此按行渲染差异，不需要额外请求。
        fileEdit.put("oldStartLine", mutation.oldStartLine());
        fileEdit.put("oldEndLine", mutation.oldEndLine());
        fileEdit.put("newStartLine", mutation.newStartLine());
        fileEdit.put("newEndLine", mutation.newEndLine());
        return Map.of("fileEdit", fileEdit);
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Summary(String path, boolean created, Integer plusLines, Integer minusLines,
                          String diffError) {
    }
}