package com.summit.dp.workflow.infrastructure.tools.file;

/**
 * 一次已落盘的文件改动，供登记与前端定位共用。
 *
 * @param diffName 差异头部显示的路径，即用户传入的原样路径
 * @param filePath 绝对路径，记录与前端定位都认它
 * @param oldContent 改动前全文；{@code null} 表示文件原本不存在
 */
public record FileMutation(String diffName, String filePath, String oldContent, String newContent,
                           int oldStartLine, int oldEndLine, int newStartLine, int newEndLine) {

    /** 基线为 {@code null} 才算新建；文件为空但存在时不算。 */
    public boolean created() {
        return oldContent == null;
    }
}