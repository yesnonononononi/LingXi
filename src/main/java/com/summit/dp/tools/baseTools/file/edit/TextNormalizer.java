package com.summit.dp.tools.baseTools.file.edit;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Fuzzy text matching helper: strips whitespace and quotes (half and full width) before matching. */
public final class TextNormalizer {

    private TextNormalizer() {
    }

    /** A range matched in the original text. */
    public record Match(int start, int end) {
    }

    /**
     * 归一化：去除所有空白字符（含全角空格）与引号（半角/全角）。
     */
    public static String normalize(String text) {
        if (text == null) return "";
        StringBuilder sb = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            // append char to result if not whitespace and not quote
            if (isKept(c)) sb.append(c);
        }
        return sb.toString();
    }

    /** Finds every range whose normalized form contains the normalized target, mapped back to the original. */
    public static List<Match> findAll(String content, String target) {
        List<Match> result = new ArrayList<>();
        if (content == null || target == null) return result;
        // normalize content and target
        String normContent = normalize(content);
        String normTarget = normalize(target);
        if (normContent.isEmpty() || normTarget.isEmpty()) return result;

        int from = 0;
        while (true) {
            int normIdx = normContent.indexOf(normTarget, from);
            if (normIdx < 0) break;
            result.add(mapBackToOriginal(content, normIdx, normIdx + normTarget.length()));
            from = normIdx + normTarget.length();
        }
        return result;
    }

    /** Builds the candidate-area message for duplicate normalized matches. */
    public static String buildDuplicateArea(List<Match> matches, String content, int aroundLine) {
        Map<Integer, String> map = new LinkedHashMap<>();
        int around = Math.max(aroundLine, 1);
        for (Match m : matches) {
            int start = FileEditor.findStartLineIndex(content, m.start());
            int end = FileEditor.findEndLineIndex(content, m.end());
            for (int j = 0; j < around; j++) {
                if (start != 0) start = FileEditor.findStartLineIndex(content, start - 1);
                if (end != content.length()) end = FileEditor.findEndLineIndex(content, end + 1);
            }
            map.put(FileEditor.findLineNumber(content, m.start()), content.substring(start, end));
        }
        return FileEditor.handleDuplicateStr(map);
    }

    /** Maps a normalized range back to the original text. */
    private static Match mapBackToOriginal(String content, int normStart, int normEnd) {
        int start = -1;
        int end = -1;
        int norm = 0;
        for (int i = 0; i < content.length(); i++) {
            if (!isKept(content.charAt(i))) continue;  // continue if char is invalid
            if (norm == normStart) start = i;
            if (norm == normEnd - 1) {
                end = i + 1;
                break;
            }
            norm++;
        }
        return new Match(start, end);
    }

    private static boolean isKept(char c) {
        return !Character.isWhitespace(c) && !isQuote(c);
    }

    private static boolean isQuote(char c) {
        return c == '\'' || c == '"' || c == '`'
                || c == '‘' || c == '’'   // full-width single quotes
                || c == '“' || c == '”';  // full-width double quotes
    }
}
