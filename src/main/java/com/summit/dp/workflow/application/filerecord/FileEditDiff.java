package com.summit.dp.workflow.application.filerecord;

/**
 * 一条编辑记录的差异视图。
 *
 * @param filePath    文件绝对路径，前端据此校验记录与当前打开的文件一致
 * @param unifiedDiff 基线到该记录末态的统一差异
 * @param truncated   是否因超过上限被截断（超限必须显式告知，不能静默丢内容）
 * @param executionId 差异所属记录的定位，前端据此判断「最新差异」是否就是当前这条
 * @param recordId    同 {@code executionId}，与 {@code /a/file-edits/{executionId}/{recordId}} 同形
 */
public record FileEditDiff(String filePath, String unifiedDiff, boolean truncated,
                           String executionId, String recordId) {
}
