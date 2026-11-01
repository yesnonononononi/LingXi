package com.summit.dp.workflow.infrastructure.tools.memory;

import java.util.ArrayList;
import java.util.List;

/** 条数和字符数同时约束，深层长路径也不能撑大初始上下文。 */
public final class MemoryWikiLimits {
    public static final int MAX_ENTRIES = 30;
    public static final int MAX_CATALOG_CHARS = 5_000;
    public static final int MAX_SEARCH_CHARS = 12_000;

    private MemoryWikiLimits() { }

    public static List<String> limitNames(List<String> names) {
        List<String> loaded = new ArrayList<>();
        int remaining = MAX_CATALOG_CHARS - 2;
        for (String name : names) {
            if (loaded.size() >= MAX_ENTRIES) break;
            // JSON 最坏会将一个字符转为六字符转义，预留引号和分隔符。
            int cost = name.length() * 6 + 4;
            if (cost > remaining) continue;
            loaded.add(name);
            remaining -= cost;
        }
        return List.copyOf(loaded);
    }
}
