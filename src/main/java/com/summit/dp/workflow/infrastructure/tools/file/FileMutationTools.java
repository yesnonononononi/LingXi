package com.summit.dp.workflow.infrastructure.tools.file;

import com.summit.dp.tools.application.port.ToolCatalog;

import java.util.Set;

/**
 * 会改动磁盘的写类工具集合：越界审批只对它们开放。
 *
 * <p>策略侧（发起审批）与恢复侧（批准后重建调用）引用同一份清单 —— 两边各写一遍时，
 * 加一个写类工具只改一边，会出现「能弹卡但批了跑不了」或反之。</p>
 */
public final class FileMutationTools {

    private static final Set<String> NAMES =
            Set.of(ToolCatalog.WRITE_FILE, ToolCatalog.EDIT_FILE, ToolCatalog.DELETE_FILE);

    private FileMutationTools() {
    }

    /** 该工具名是否属于写类工具。 */
    public static boolean contains(String toolName) {
        return toolName != null && NAMES.contains(toolName.trim());
    }
}
