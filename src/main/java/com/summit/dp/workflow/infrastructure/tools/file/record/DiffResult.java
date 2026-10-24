package com.summit.dp.workflow.infrastructure.tools.file.record;

import lombok.Builder;
import lombok.Getter;

import java.util.List;

@Getter
@Builder
public class DiffResult {
    private Integer code;
    private String errMsg;
    private List<String> diffs;

    public static DiffResult success(List<String> diffs) {
        return DiffResult.builder()
                .code(1)
                .diffs(diffs)
                .build();
    }

    public static DiffResult fail(String errMsg) {
        return DiffResult.builder()
                .code(0)
                .errMsg(errMsg)
                .build();
    }

    public boolean isSuccess() {
        return code == 1;
    }

    public String unifiedDiff() {
        return diffs == null ? "" : String.join("\n", diffs);
    }

    public int plusLines() {
        return countDiffLines(diffs, '+');
    }

    public int minusLines() {
        return countDiffLines(diffs, '-');
    }

    /** 编辑摘要和待决记录必须共用计数口径，避免前端显示不同的增删行数。 */
    public static int countDiffLines(List<String> diffs, char marker) {
        if (diffs == null) {
            return 0;
        }
        int count = 0;
        boolean inHunk = false;
        for (String line : diffs) {
            if (line.startsWith("@@ ")) {
                inHunk = true;
            } else if (inHunk && !line.isEmpty() && line.charAt(0) == marker) {
                // 只统计差异块正文；空白行也算，文件头不算。
                count++;
            }
        }
        return count;
    }
}
