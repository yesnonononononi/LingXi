package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import org.jspecify.annotations.NonNull;

import java.nio.charset.Charset;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

public  class FileEditor {

    private static final String DUPLICATE_AREA_FORMAT = """
            原文或锚点命中多处，请增加上下文以唯一定位
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
     * 从起始行推算文本覆盖到的最后一行。
     *
     * <p>末尾换行只表示「该行结束」，不多占一行，否则每个以换行结尾的编辑区间都会多算一行。
     * 调用方保证 {@code startLine >= 1} 且文本非空（插入空字符串是无操作编辑，直接沿用起始行）；
     * 行号 0 表示「该侧不存在」，不进入本方法。</p>
     */
    static int endLineOf(int startLine, String text) {
        if (text.isEmpty()) {
            return startLine;
        }
        int newlines = 0;
        for (int i = 0; i < text.length(); i++) {
            if (text.charAt(i) == '\n') {
                newlines++;
            }
        }
        int span = text.endsWith("\n") ? newlines - 1 : newlines;
        return startLine + Math.max(span, 0);
    }

    static int findEndLineIndex(String content, int index) {
        int end = content.indexOf("\n", index);
        return end == -1 ? content.length() : end;
    }

    static int findStartLineIndex(String content, int index) {
        int start = content.lastIndexOf("\n", index - 1); // 排除当前位置的换行符，才能定位所属行的起点。
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

            startIndex = i + 1;

            result.put(findLineNumber(fileContent, i), area);

        }
        return result;
    }

}
