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

                // 锚点必须逐字一致，不能忽略空白和引号后猜测插入位置。
                if ((insertIndex = content.indexOf(anchor)) == -1) {
                    return FileEditorResult.err("未找到完全一致的锚点，请重新读取文件后编辑");
                }
                int anchorEnd = insertIndex + anchor.length();
                // 重叠的命中同样不能自动选取。
                if (content.indexOf(anchor, insertIndex + 1) != -1) {
                    Map<Integer, String> duplicateArea = FileEditor.resolveDuplicateArea(anchor, content, aroundLines);
                    return FileEditorResult.err(FileEditor.handleDuplicateStr(duplicateArea));
                }
                String newContent;
                if (type.equals(EditType.INSERT_BEFORE)) {
                    newContent = content.substring(0, insertIndex) + newText + content.substring(insertIndex);
                } else {
                    newContent = content.substring(0, anchorEnd) + newText + content.substring(anchorEnd);
                }
                return FileEditorResult.success(
                        FileEditorResult.ContentInfo.builder()
                                .oldContent(content)
                                .newContent(newContent)
                                .build()
                );
            } else {
                if (newText.isEmpty()) return FileEditorResult.err("文件和待插入内容不能同时为空");

                return FileEditorResult.success(
                        FileEditorResult.ContentInfo.builder()
                                .oldContent("")
                                .newContent(newText)
                                .build()
                );
            }

        } catch (
                Exception e) {
            return FileEditorResult.err(e.getMessage());
        }
    }

}
