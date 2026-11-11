package com.summit.dp.workflow.application.chat;

import com.summit.core.workspace.WorkspaceSpec;

import java.util.List;

/**
 * 记忆正文来源：返回值按顺序并入 {@code ContextSpec.memory}，由框架追加到系统提示词尾部。
 *
 * <p>返回空列表表示「本轮不参与」；未绑定工作区、文件缺失都走这条 —— 记忆是可选增强，
 * 读不到不能把一次请求受理变成失败。</p>
 */
@FunctionalInterface
public interface MemoryLoader {
    List<String> load(WorkspaceSpec workspace);

    /**
     * 按注册顺序汇总所有来源。
     *
     * <p>根会话与子 Agent 必须走同一个入口：两边各写一遍 flatMap，迟早一边改了另一边没改，
     * 「统一口径」就成了口头约定。</p>
     */
    static List<String> collect(List<MemoryLoader> loaders, WorkspaceSpec workspace) {
        return loaders.stream().flatMap(loader -> loader.load(workspace).stream()).toList();
    }
}