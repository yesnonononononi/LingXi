package com.summit.dp.workflow.infrastructure.tools.memory;

import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.workflow.application.chat.ProjectMemoryPrompt;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 三层记忆的使用规则。
 *
 * <p>只发规则不发目录：目录是随项目变化的事实，由 {@link MemoryWikiIndexLoader}
 * 放进 {@code ContextSpec.memory}，两处各管一件事，避免同一份目录被注入两遍。</p>
 */
@Component
public class MemoryWikiPromptLoader implements ProjectMemoryPrompt {

    private final String instructions;

    public MemoryWikiPromptLoader(@Value("${lingxi.memory.instructions:}") String instructions) {
        this.instructions = instructions;
    }

    @Override
    public String load(WorkspaceSpec workspace) {
        String prompt = "## 三层记忆与项目 wiki\n" + instructions + "\n\n";
        if (workspace == null) {
            return prompt + "当前会话未指定项目，跳过项目 wiki 加载；可以继续交流，不要求先选择工作空间。";
        }
        return prompt;
    }
}