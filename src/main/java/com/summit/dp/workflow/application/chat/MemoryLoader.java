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
}