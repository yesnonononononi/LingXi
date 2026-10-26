package com.summit.dp.workflow.infrastructure.tools.file.edit;

import java.util.Map;

/** 换行只参与等价定位；拼接仍使用原文下标，避免改写未编辑区域。 */
final class FileTextMatcher {
    private final String content;
    private final String normalizedContent;
    private final String normalizedMatch;

    FileTextMatcher(String content, String match) {
        this.content = content;
        this.normalizedContent = content.replace("\r\n", "\n");
        this.normalizedMatch = match.replace("\r\n", "\n");
    }

    int find(int fromIndex) {
        return normalizedContent.indexOf(normalizedMatch, fromIndex);
    }

    int matchLength() {
        return normalizedMatch.length();
    }

    int toOriginalIndex(int normalizedIndex) {
        int originalIndex = 0;
        for (int index = 0; index < normalizedIndex; index++) {
            if (content.charAt(originalIndex) == '\r' && originalIndex + 1 < content.length()
                    && content.charAt(originalIndex + 1) == '\n') {
                originalIndex++;
            }
            originalIndex++;
        }
        return originalIndex;
    }

    Map<Integer, String> duplicateAreas(Integer aroundLines) {
        return FileEditor.resolveDuplicateArea(normalizedMatch, normalizedContent, aroundLines);
    }

    String normalizeNewText(String newText, int originalIndex) {
        int newline = content.indexOf('\n', originalIndex);
        if (newline == -1) {
            newline = content.lastIndexOf('\n', originalIndex - 1);
        }
        // 没有既有换行约定时沿用输入，不让服务器操作系统决定文件格式。
        if (newline == -1) {
            return newText;
        }
        String normalized = newText.replace("\r\n", "\n");
        return newline > 0 && content.charAt(newline - 1) == '\r'
                ? normalized.replace("\n", "\r\n") : normalized;
    }
}
