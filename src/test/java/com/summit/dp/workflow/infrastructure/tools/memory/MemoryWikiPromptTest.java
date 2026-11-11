package com.summit.dp.workflow.infrastructure.tools.memory;

import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.workflow.application.chat.BusinessSystemPromptBuilder;
import com.summit.dp.workspace.application.convert.LingXiWorkspaceSpec;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 提示词侧只发规则、不发目录。
 *
 * <p>目录搬去 {@code ContextSpec.memory}（见 {@link MemoryWikiIndexLoaderTest}）：
 * 同一个事实两处都写，改一处忘一处就会变成「规则说 30 条、目录给 50 条」。</p>
 */
class MemoryWikiPromptTest {

    @TempDir
    Path project;

    @Test
    @DisplayName("根提示词只拼规则段，不夹带目录 JSON")
    void rootPromptCarriesRulesOnly() throws Exception {
        Files.createDirectories(project.resolve("wiki"));
        Files.writeString(project.resolve("wiki/module.md"), "模块正文");

        String prompt = builder().buildRootPrompt("角色规则", null, spec(project));

        assertTrue(prompt.startsWith("固定全局规则\n\n角色规则\n\n"), prompt);
        assertTrue(prompt.contains("## 三层记忆与项目 wiki"), prompt);
        assertTrue(prompt.contains("三层记忆规则"), prompt);
        assertFalse(prompt.contains("module.md"), "目录已搬到 memory，系统提示词里不能再出现: " + prompt);
        assertFalse(prompt.contains("模块正文"), prompt);
    }

    @Test
    @DisplayName("未指定项目时保留「可以继续交流」的出口")
    void unselectedProjectKeepsAnExit() {
        String prompt = builder().buildRootPrompt("角色规则", null, null);

        assertTrue(prompt.contains("可以继续交流"), prompt);
        assertFalse(prompt.contains("项目 wiki 目录"), prompt);
    }

    @Test
    @DisplayName("成员提示词同样只带规则，不改变原有结构")
    void memberPromptCarriesRulesWithoutCatalog() {
        AgentVO member = new AgentVO();
        member.setId(6L);
        member.setPrompt("成员职责");

        String prompt = builder().buildMemberPrompt(member, null, "交付任务", spec(project));

        assertTrue(prompt.startsWith("成员职责"), prompt);
        assertTrue(prompt.contains("交付任务"), prompt);
        assertTrue(prompt.contains("三层记忆规则"), prompt);
        assertFalse(prompt.contains("\"total\""), prompt);
    }

    private BusinessSystemPromptBuilder builder() {
        return new BusinessSystemPromptBuilder("固定全局规则", new MemoryWikiPromptLoader("三层记忆规则"));
    }

    private WorkspaceSpec spec(Path root) {
        return new LingXiWorkspaceSpec("local", root.toString(), Map.of());
    }
}