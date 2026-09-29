package com.summit.dp.tools.baseTools.file.edit;


import com.summit.dp.tools.baseTools.arguments.EditFileRequest;
import org.jspecify.annotations.NonNull;

import java.nio.charset.Charset;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public class FileUpdater {
    public static FileEditorResult update(EditFileRequest editFileRequest, @NonNull String content, Charset charset, Integer aroundLines){
        int oldIndex ;
        String newText = Objects.requireNonNullElse(editFileRequest.getNewText(),"");
        String oldText = editFileRequest.getOldText();

        try {
            EditType type = EditType.fromString(editFileRequest.getType());
            if (oldText == null || oldText.isBlank()) return FileEditorResult.err("old text is empty");

            //1, validate newText whether duplicate or not
            if(content.isEmpty())   return FileEditorResult.err("file is empty");

            // ensure old text exist in file: exact match first, then normalized match as fallback
            int oldEnd;
            oldIndex = content.indexOf(oldText);
            if (oldIndex == -1) {
                List<TextNormalizer.Match> matches = TextNormalizer.findAll(content, oldText);
                if (matches.isEmpty()) {
                    return FileEditorResult.err("old text not found");
                }
                if (matches.size() > 1) {
                    return FileEditorResult.err(TextNormalizer.buildDuplicateArea(matches, content, aroundLines));
                }
                oldIndex = matches.getFirst().start();
                oldEnd = matches.getFirst().end();
            } else {
                // ensure old text not duplicate in file
                oldEnd = oldIndex + oldText.length();
                if (content.indexOf(oldText, oldEnd) != -1) {
                    Map<Integer, String> duplicateArea = FileEditor.resolveDuplicateArea(oldText, content, aroundLines);
                    return FileEditorResult.err(FileEditor.handleDuplicateStr(duplicateArea));
                }
            }

            //2, edit. replace old text with new text and is equal result for DELETE type when newText is empty
            //2.1 handle DELETE type. force new text to empty
            if(type.equals(EditType.DELETE)) newText = "";

            String newContent =
                    content.substring(0, oldIndex)
                            + newText
                            + content.substring(oldEnd);

           // Files.writeString(targetFile.toPath(), newContent, charset);

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
