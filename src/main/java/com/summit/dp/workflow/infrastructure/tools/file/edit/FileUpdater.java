package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import org.jspecify.annotations.NonNull;

import java.nio.charset.Charset;
import java.util.Map;

public class FileUpdater {
    public static FileEditorResult update(EditFileRequest editFileRequest, @NonNull String content, Charset charset, Integer aroundLines){
        String newText = editFileRequest.getNewText();
        String oldText = editFileRequest.getOldText();

        try {
            EditType type = EditType.fromString(editFileRequest.getType());
            if (type == EditType.REPLACE && newText == null) return FileEditorResult.err("替换文件时必须提供 newText");
            if (oldText == null || oldText.isBlank()) return FileEditorResult.err("被替换或删除的原文不能为空");

            if(content.isEmpty()) return FileEditorResult.err("文件内容为空，无法定位原文");

            // 只统一换行参与定位，空白、引号等其他字符仍须完全一致。
            FileTextMatcher matcher = new FileTextMatcher(content, oldText);
            int oldIndex = matcher.find(0);
            if (oldIndex == -1) {
                return FileEditorResult.err("未找到完全一致的原文，请重新读取文件后编辑");
            }

            // 从起点后一位检查，重叠的命中同样存在定位歧义。
            if (matcher.find(oldIndex + 1) != -1) {
                Map<Integer, String> duplicateArea = matcher.duplicateAreas(aroundLines);
                return FileEditorResult.err(FileEditor.handleDuplicateStr(duplicateArea));
            }

            int oldStart = matcher.toOriginalIndex(oldIndex);
            int oldEnd = matcher.toOriginalIndex(oldIndex + matcher.matchLength());
            newText = type == EditType.DELETE ? "" : matcher.normalizeNewText(newText, oldStart);

            String newContent =
                    content.substring(0, oldStart)
                            + newText
                            + content.substring(oldEnd);

            return FileEditorResult.success(FileEditorResult.ContentInfo.builder()
                    .oldContent(content)
                    .newContent(newContent)
                    .build()
            );
        } catch (Exception e){
            return FileEditorResult.err(e.getMessage());
        }

    }
}
