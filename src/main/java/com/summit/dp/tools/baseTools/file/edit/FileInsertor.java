package com.summit.dp.tools.baseTools.file.edit;


import com.summit.dp.tools.baseTools.arguments.EditFileRequest;
import org.jspecify.annotations.NonNull;

import java.nio.charset.Charset;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public class FileInsertor  {
    public static FileEditorResult insert(EditFileRequest editFileRequest, @NonNull String content, Charset charset, Integer aroundLines) {
        int insertIndex;
        EditType type = EditType.fromString(editFileRequest.getType());
        String newText = Objects.requireNonNullElse(editFileRequest.getNewText(), "");
        String anchor = editFileRequest.getAnchor();
        try {

            if (!content.isEmpty()) {
                if (anchor == null || anchor.isEmpty())
                    return FileEditorResult.err("anchor is empty. There are no ways to insure position is correct");

                // ensure anchor exists in file: exact match first, then normalized match as fallback
                int anchorEnd;
                if ((insertIndex = content.indexOf(anchor)) == -1) {
                    List<TextNormalizer.Match> matches = TextNormalizer.findAll(content, anchor);
                    if (matches.isEmpty()) {
                        return FileEditorResult.err("anchor not found");
                    }
                    if (matches.size() > 1) {
                        return FileEditorResult.err(TextNormalizer.buildDuplicateArea(matches, content, aroundLines));
                    }
                    insertIndex = matches.getFirst().start();
                    anchorEnd = matches.getFirst().end();
                } else {
                    anchorEnd = insertIndex + anchor.length();
                    // ensure anchor not duplicate in file
                    if (content.indexOf(anchor, anchorEnd) != -1) {
                        Map<Integer, String> duplicateArea = FileEditor.resolveDuplicateArea(anchor, content, aroundLines);
                        return FileEditorResult.err(FileEditor.handleDuplicateStr(duplicateArea));
                    }
                }
                String newContent;
                if (type.equals(EditType.INSERT_BEFORE)) {
                    newContent = content.substring(0, insertIndex) + newText + content.substring(insertIndex);
                } else {
                    newContent = content.substring(0, anchorEnd) + newText + content.substring(anchorEnd);
                }
                // Files.writeString(targetFile.toPath(), newContent, charset);
                return FileEditorResult.success(
                        FileEditorResult.ContentInfo.builder()
                                .oldContent(content)
                                .newContent(newContent)
                                .build()
                );
            } else {
                if (newText.isEmpty()) return FileEditorResult.err("both the file and the inserted content are empty");

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
