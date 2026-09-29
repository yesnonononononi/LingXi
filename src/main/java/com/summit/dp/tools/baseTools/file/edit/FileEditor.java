package com.summit.dp.tools.baseTools.file.edit;


import com.summit.dp.tools.baseTools.arguments.EditFileRequest;
import org.jspecify.annotations.NonNull;

import java.io.File;
import java.nio.charset.Charset;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

public  class FileEditor {


    private static final String DUPLICATE_AREA_FORMAT = """
            duplicate old text in target file, require choice a specific area
            %s
            """;

    public static FileEditorResult edit(EditFileRequest editFileRequest, @NonNull String content, Charset charset, Integer aroundLines) {

        EditType type = EditType.fromString(editFileRequest.getType());
        return switch (type) {
            case INSERT_AFTER, INSERT_BEFORE -> FileInsertor.insert(editFileRequest, content, charset, aroundLines);
            case REPLACE, DELETE -> FileUpdater.update(editFileRequest, content, charset, aroundLines);
        };
    }


    protected static String handleDuplicateStr(Map<Integer, String> areaMap) {
        StringBuilder strBuilder = new StringBuilder();
        areaMap.forEach((index, str) -> {
            strBuilder.append(String.format("line %d : \n %s \n", index, str));
        });
        return String.format(DUPLICATE_AREA_FORMAT, strBuilder);
    }

    static int findLineNumber(String content, int index) {
        int line = 1;
        for (int i = 0; i < index; i++) {
            if (content.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }

    /**
     * find the index of the end of the line
     *
     * @param content the content of the file
     * @param index   the index of the character
     * @return the index of the end of the line
     */
    static int findEndLineIndex(String content, int index) {
        int end = content.indexOf("\n", index);
        return end == -1 ? content.length() : end;
    }

    /**
     * find the index of the start of the line
     *
     * @param content the content of the file
     * @param index   the index of the character
     * @return the index of the start of the line
     */
    static int findStartLineIndex(String content, int index) {
        int start = content.lastIndexOf("\n", index - 1); // from behind to front. sink  '\n'. the reason why index-1 is to avoid '\n' at index
        return start == -1 ? 0 : start + 1;
    }

    protected static Map<Integer, String> resolveDuplicateArea(String matchStr, String fileContent, Integer aroundLine) {
        if (matchStr == null || matchStr.isEmpty()) return Map.of();
        LinkedHashMap<Integer, String> result = new LinkedHashMap<>();
        int startIndex = 0;
        while (true) {
            int i = fileContent.indexOf(matchStr, startIndex);
            if (i == -1) break;

            int startlineIndex = findStartLineIndex(fileContent, i),
                    endLineIndex = findEndLineIndex(fileContent, i + matchStr.length());

            for (int j = 0; j < Objects.requireNonNullElse(aroundLine, 3); j++) {
                if (startlineIndex != 0) startlineIndex = findStartLineIndex(fileContent, startlineIndex - 1);
                if (endLineIndex != fileContent.length())
                    endLineIndex = findEndLineIndex(fileContent, endLineIndex + 1);
            }

            String area = fileContent.substring(
                    startlineIndex,
                    endLineIndex
            );

            startIndex = i + matchStr.length();

            result.put(findLineNumber(fileContent, i), area);

        }
        return result;
    }


}
