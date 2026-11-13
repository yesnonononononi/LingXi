package com.summit.dp.workflow.infrastructure.tools.file.write;

import com.summit.dp.workflow.infrastructure.tools.file.edit.FileEditor;
import com.summit.dp.workflow.infrastructure.tools.file.edit.FileEditorResult;
import org.jspecify.annotations.NonNull;

/**
 * 整文件写入的纯文本计算：只算落盘后的全文与行号，不做存在性判断也不碰文件系统。
 *
 * <p>头插与追加都是逐字拼接、不自动补换行 —— 换行由调用方自己写进 {@code content}，
 * 否则「追加一行」会被悄悄变成「接到最后一行尾巴上」。</p>
 */
public class FileWriter {

    public static FileEditorResult write(WriteType type, String content, @NonNull String oldContent) {
        return switch (type) {
            case CREATE -> created(content);
            case OVERRIDE -> overridden(content, oldContent);
            case PREPEND -> prepended(content, oldContent);
            case APPEND -> appended(content, oldContent);
        };
    }

    private static FileEditorResult created(String content) {
        return FileEditorResult.success(FileEditorResult.ContentInfo.builder()
                .oldContent("")
                .newContent(content)
                .oldStartLine(0)
                .oldEndLine(0)
                .newStartLine(contentStartLine(content))
                .newEndLine(content.isEmpty() ? 0 : FileEditor.endLineOf(1, content))
                .build());
    }

    private static FileEditorResult overridden(String content, String oldContent) {
        boolean oldEmpty = oldContent.isEmpty();
        return FileEditorResult.success(FileEditorResult.ContentInfo.builder()
                .oldContent(oldContent)
                .newContent(content)
                .oldStartLine(oldEmpty ? 0 : 1)
                .oldEndLine(oldEmpty ? 0 : FileEditor.endLineOf(1, oldContent))
                .newStartLine(contentStartLine(content))
                .newEndLine(content.isEmpty() ? 0 : FileEditor.endLineOf(1, content))
                .build());
    }

    private static FileEditorResult prepended(String content, String oldContent) {
        if (content.isEmpty()) {
            return emptyIncoming();
        }
        return inserted(content, content + oldContent, 1);
    }

    private static FileEditorResult appended(String content, String oldContent) {
        if (content.isEmpty()) {
            return emptyIncoming();
        }
        // 追加点所在的 1 基行号：原内容末尾是换行时，新内容从下一行开始。
        int insertLine = FileEditor.findLineNumber(oldContent, oldContent.length());
        return inserted(content, oldContent + content, insertLine);
    }

    private static FileEditorResult inserted(String content, String newContent, int insertLine) {
        // 插入不覆盖旧行，旧侧区间固定为 0。
        return FileEditorResult.success(FileEditorResult.ContentInfo.builder()
                .oldContent("")
                .newContent(newContent)
                .oldStartLine(0)
                .oldEndLine(0)
                .newStartLine(insertLine)
                .newEndLine(FileEditor.endLineOf(insertLine, content))
                .build());
    }

    private static FileEditorResult emptyIncoming() {
        return FileEditorResult.err("头插或追加的内容不能为空，清空整份文件请使用 OVERRIDE");
    }

    private static int contentStartLine(String content) {
        return content.isEmpty() ? 0 : 1;
    }
}