package com.summit.dp.workflow.infrastructure.tools.memory;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.workflow.application.chat.MemoryLoader;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 项目 wiki 目录索引作为记忆正文下发，根会话与子 Agent 各取一份自己的项目目录。
 *
 * <p>与 {@link MemoryWikiPromptLoader} 的分工：那个只发布「三层记忆怎么用」的规则，
 * 这里发布「本项目的目录长什么样」。规则与事实分开，才不会一处改动另一处自相矛盾。</p>
 */
@Slf4j
@Component
@Order(20)
public class MemoryWikiIndexLoader implements MemoryLoader {

    private final ObjectProvider<MemoryWikiManager> managers;
    private final WorkspaceResolver workspaces;
    private final ObjectMapper objectMapper;

    public MemoryWikiIndexLoader(ObjectProvider<MemoryWikiManager> managers, WorkspaceResolver workspaces,
                                 ObjectMapper objectMapper) {
        this.managers = managers;
        this.workspaces = workspaces;
        this.objectMapper = objectMapper;
    }

    @Override
    public List<String> load(WorkspaceSpec workspace) {
        if (workspace == null) return List.of();
        try {
            // 单例执行器必须按调用获取原型，构造器直接注入会把原型固定成共享实例。
            MemoryWikiManager manager = managers.getObject();
            manager.loadWikis(workspaces.resolve(workspace));
            return List.of("### 项目 wiki 索引\n目录 JSON：" + objectMapper.writeValueAsString(manager.catalog())
                    + "\n目录最多展示 30 条，不含正文；目录不完整时用 search_wiki 按关键词检索全部模块，"
                    + "再用 load_memory 按 wikiName 读取正文。");
        } catch (Exception error) {
            // 目录是可选增强，读不到只告警，不阻断本轮对话。
            log.warn("加载项目 wiki 索引失败: workDir={}", workspace.workDir(), error);
            return List.of();
        }
    }
}