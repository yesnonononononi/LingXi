package com.summit.dp.workflow.application.chat;

import com.summit.core.workspace.WorkspaceSpec;

/** 只返回待构建的提示词，不读取或修改执行上下文。 */
@FunctionalInterface
public interface ProjectMemoryPrompt {
    String load(WorkspaceSpec workspace);
}
