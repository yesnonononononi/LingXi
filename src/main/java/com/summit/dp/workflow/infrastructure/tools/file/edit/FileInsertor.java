package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import org.jspecify.annotations.NonNull;

import java.nio.charset.Charset;
import java.util.Map;

public class FileInsertor  {
    public static FileEditorResult insert(EditFileRequest editFileRequest, @NonNull String content, Charset charset, Integer aroundLines) {
        int insertIndex;
        EditType type = EditType.fromString(editFileRequest.getType());
        String newText = editFileRequest.getNewText();
        String anchor = editFileRequest.getAnchor();
        try {
            if (newText == null) return FileEditorResult.err("插入文件时必须提供 newText");

            if (!content.isEmpty()) {
                if (anchor == null || anchor.isEmpty())
                    return FileEditorResult.err("插入位置的锚点不能为空");

                // 换行等价不能放宽其他字符，也不能自动选择多个命中中的一个。
                FileTextMatcher matcher = new FileTextMatcher(content, anchor);
                if ((insertIndex = matcher.find(0)) == -1) {
                    return FileEditorResult.err("未找到完全一致的锚点，请重新读取文件后编辑");
                }
                int anchorEnd = matcher.toOriginalIndex(insertIndex + matcher.matchLength());
                // 重叠的命中同样不能自动选取。
                if (matcher.find(insertIndex + 1) != -1) {
                    Map<Integer, String> duplicateArea = matcher.duplicateAreas(aroundLines);
                    return FileEditorResult.err(FileEditor.handleDuplicateStr(duplicateArea));
                }
                insertIndex = matcher.toOriginalIndex(insertIndex);
                newText = matcher.normalizeNewText(newText, type == EditType.INSERT_BEFORE ? insertIndex : anchorEnd);
                String newContent;
                // 插入点所在行即新内容起始行；插入不覆盖旧行，旧侧区间固定为 0。
                int insertLine;
                if (type.equals(EditType.INSERT_BEFORE)) {
                    newContent = content.substring(0, insertIndex) + newText + content.substring(insertIndex);
                    insertLine = FileEditor.findLineNumber(content, insertIndex);
                } else {
                    newContent = content.substring(0, anchorEnd) + newText + content.substring(anchorEnd);
                    insertLine = FileEditor.findLineNumber(content, anchorEnd);
                }
                return FileEditorResult.success(
                        FileEditorResult.ContentInfo.builder()
                                .oldContent(content)
                                .newContent(newContent)
                                .oldStartLine(0)
                                .oldEndLine(0)
                                .newStartLine(insertLine)
                                .newEndLine(FileEditor.endLineOf(insertLine, newText))
                                .build()
                );
            } else {
                if (newText.isEmpty()) return FileEditorResult.err("文件和待插入内容不能同时为空");

                return FileEditorResult.success(
                        FileEditorResult.ContentInfo.builder()
                                .oldContent("")
                                .newContent(newText)
                                .oldStartLine(0)
                                .oldEndLine(0)
                                .newStartLine(1)
                                .newEndLine(FileEditor.endLineOf(1, newText))
                                .build()
                );
            }

        } catch (
                Exception e) {
            return FileEditorResult.err(e.getMessage());
        }
    }

}
