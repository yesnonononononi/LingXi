package com.summit.dp.workflow.infrastructure.tools.memory;

import com.summit.dp.workspace.domain.model.Workspace;
import com.summit.dp.workspace.domain.repository.WorkspaceRepository;
import com.summit.runtime.workspace.LocalWorkspace;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/** 已登记项目在启动时预热，新项目仍可在首次使用时加载。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class MemoryWikiStartupLoader implements ApplicationRunner {
    private final WorkspaceRepository workspaces;
    private final ObjectProvider<MemoryWikiManager> managers;

    @Override
    public void run(ApplicationArguments args) {
        for (Workspace workspace : workspaces.findAll()) {
            try {
                // 预热只扫描宿主目录，不启动沙箱，也不读取正文。
                managers.getObject().loadWikis(new LocalWorkspace("wiki-startup", workspace.getHostDir()));
            } catch (Exception error) {
                log.warn("预热项目 wiki 索引失败: workspaceId={}, hostDir={}",
                        workspace.getId(), workspace.getHostDir(), error);
            }
        }
    }
}
