package com.summit.dp.workflow.application.filerecord;

/**
 * 一条编辑记录的差异视图。
 *
 * @param filePath    文件绝对路径，前端据此校验记录与当前打开的文件一致
 * @param unifiedDiff 基线到该记录末态的统一差异
 * @param truncated   是否因超过上限被截断（超限必须显式告知，不能静默丢内容）
 */
public record FileEditDiff(String filePath, String unifiedDiff, boolean truncated) {
}
