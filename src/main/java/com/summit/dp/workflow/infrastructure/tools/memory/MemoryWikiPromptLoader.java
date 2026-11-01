package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.workflow.application.chat.ProjectMemoryPrompt;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.List;

/** 目录在请求创建时定稿，不向执行过程引入额外状态。 */
@Slf4j
@Component
public class MemoryWikiPromptLoader implements ProjectMemoryPrompt {
    private final ObjectProvider<MemoryWikiManager> managers;
    private final WorkspaceResolver workspaces;
    private final ObjectMapper objectMapper;
    private final String instructions;

    public MemoryWikiPromptLoader(ObjectProvider<MemoryWikiManager> managers, WorkspaceResolver workspaces,
                                  ObjectMapper objectMapper, @Value("${lingxi.memory.instructions:}") String instructions) {
        this.managers = managers;
        this.workspaces = workspaces;
        this.objectMapper = objectMapper;
        this.instructions = instructions;
    }

    @Override
    public String load(WorkspaceSpec workspace) {
        String prompt = "## 三层记忆与项目 wiki\n" + instructions + "\n\n";
        if (workspace == null) {
            return prompt + "当前会话未指定项目，跳过项目 wiki 加载；可以继续交流，不要求先选择工作空间。";
        }
        try {
            MemoryWikiManager manager = managers.getObject();
            manager.loadWikis(workspaces.resolve(workspace));
            List<String> loaded = manager.getLoadedWikis();
            return prompt + "项目 wiki 目录：" + objectMapper.writeValueAsString(
                    new Catalog(manager.getWikis().size(), loaded.size(), loaded))
                    + "\n目录最多展示 30 条，不含正文。使用 search_wiki 检索全部模块，load_memory 读取指定 wiki。"
                    + "\n项目长期记忆按模块存入 wiki，每个模块一个文件，按模块名.md 命名。";
        } catch (Exception error) {
            // 可选记忆读取失败不改变业务事实，不能阻断无关对话。
            log.warn("加载执行前 wiki 目录失败: workDir={}", workspace.workDir(), error);
            return prompt + "项目 wiki 目录暂时无法加载；仍可继续当前任务，需要记忆时再使用 search_wiki 或 load_memory。";
        }
    }

    private record Catalog(int total, int returned, List<String> wikis) { }
}
