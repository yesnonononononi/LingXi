package com.summit.dp.workflow.infrastructure.tools.memory;

import java.util.ArrayList;
import java.util.List;

/** 条数和字符数同时约束，深层长路径也不能撑大初始上下文。 */
public final class MemoryWikiLimits {
    public static final int MAX_ENTRIES = 30;
    public static final int MAX_CATALOG_CHARS = 5_000;
    public static final int MAX_SEARCH_CHARS = 12_000;
    /** 关键词上限；超长关键词截断后继续检索，不能因为关键词过长整轮失败。 */
    public static final int MAX_KEYWORD_CHARS = 256;
    /** 目录 JSON 信封（{@code total}/{@code returned}/{@code wikis} 键名与括号）预留的字符数。 */
    private static final int CATALOG_ENVELOPE_CHARS = 128;

    private MemoryWikiLimits() { }

    /**
     * 按条数与字符预算裁剪目录名称。
     *
     * <p>预算里先扣掉目录 JSON 的信封字段，保证裁剪后的<b>完整</b> JSON 仍不超过
     * {@link #MAX_CATALOG_CHARS}，否则框架按字符数截断会留下半截 JSON，调用方解析直接失败。</p>
     *
     * @param names 候选名称，{@code null} 或空表示没有目录
     * @return 不可变名称列表，最多 {@link #MAX_ENTRIES} 条
     */
    public static List<String> limitNames(List<String> names) {
        if (names == null || names.isEmpty()) return List.of();
        List<String> loaded = new ArrayList<>();
        int remaining = MAX_CATALOG_CHARS - CATALOG_ENVELOPE_CHARS;
        for (String name : names) {
            if (name == null) continue;
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
