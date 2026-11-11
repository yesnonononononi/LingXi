package com.summit.dp.workflow.infrastructure.memory;

import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.utils.TokenEstimatorTestSupport;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 项目公约能否变成记忆正文：读不到一律空列表，超长要截断并且说清截断了。 */
class AgentsMdLoaderTest {

    /** 1 字符 = 1 token，便于把截断边界写死在用例里。 */
    private AgentsMdLoader loader(int maxTokens) {
        return new AgentsMdLoader(TokenEstimatorTestSupport.charCount(), maxTokens);
    }

    @Test
    @DisplayName("项目根的 AGENTS.md 成为一条记忆正文，并标出来源")
    void loadsAgentsMdAsOneMemoryBody(@TempDir Path project) throws IOException {
        Files.writeString(project.resolve("AGENTS.md"), "# 公约\n禁止打补丁\n", StandardCharsets.UTF_8);

        List<String> memory = loader(3000).load(spec(project));

        assertEquals(1, memory.size());
        assertTrue(memory.get(0).startsWith("### 项目公约（AGENTS.md）"), memory.get(0));
        assertTrue(memory.get(0).contains("禁止打补丁"), memory.get(0));
        assertFalse(memory.get(0).contains("【已截断】"), memory.get(0));
    }

    @Test
    @DisplayName("小写 agents.md 同样认：Linux 上文件名大小写敏感")
    void acceptsLowerCaseFileName(@TempDir Path project) throws IOException {
        Files.writeString(project.resolve("agents.md"), "小写也能读\n", StandardCharsets.UTF_8);

        assertEquals(1, loader(3000).load(spec(project)).size());
    }

    @Test
    @DisplayName("两个候选文件名都在：Windows/macOS 大小写不敏感，行为用例分不出差异，这里守住配置本身")
    void keepsBothSpellings() {
        assertEquals(List.of("AGENTS.md", "agents.md"), AgentsMdLoader.FILE_NAMES);
    }

    @Test
    @DisplayName("没有工作区或没有公约文件时返回空列表，不抛异常")
    void returnsEmptyWhenAbsent(@TempDir Path project) {
        WorkspaceSpec unbound = new WorkspaceSpec() {
            @Override
            public String provider() {
                return "test";
            }

            @Override
            public String workDir() {
                return " ";
            }
        };

        assertEquals(List.of(), loader(3000).load(null));
        assertEquals(List.of(), loader(3000).load(unbound));
        assertEquals(List.of(), loader(3000).load(new MxcWorkspaceSpec(project.resolve("absent").toString())));
        assertEquals(List.of(), loader(3000).load(spec(project)));
    }

    @Test
    @DisplayName("空白文件不产生空记忆段")
    void blankFileProducesNoSegment(@TempDir Path project) throws IOException {
        Files.writeString(project.resolve("AGENTS.md"), "  \n\n", StandardCharsets.UTF_8);

        assertEquals(List.of(), loader(3000).load(spec(project)));
    }

    @Test
    @DisplayName("超过上限按行截断，并告知已截断、原文位置和自行阅读的方式")
    void truncatesBeyondTheTokenLimitAndSaysSo(@TempDir Path project) throws IOException {
        Files.writeString(project.resolve("AGENTS.md"), "甲乙丙丁戊\n子丑寅卯辰\n庚辛壬癸子\n", StandardCharsets.UTF_8);
        // 每行 5 字 + 换行 = 6 token；上限 10 只装得下第一行。
        String memory = loader(10).load(spec(project)).get(0);

        assertTrue(memory.contains("甲乙丙丁戊"), memory);
        assertFalse(memory.contains("子丑寅卯辰"), "超限的行不能进正文: " + memory);
        assertTrue(memory.contains("【已截断】"), memory);
        assertTrue(memory.contains("read_file"), memory);
        assertTrue(memory.contains(project.resolve("AGENTS.md").toAbsolutePath().toString()), memory);
        assertTrue(memory.contains("超过 10 token 上限"), memory);
    }

    @Test
    @DisplayName("恰好等于上限不截断：截断只在超出时发生")
    void keepsContentAtExactlyTheLimit(@TempDir Path project) throws IOException {
        Files.writeString(project.resolve("AGENTS.md"), "一二三四五\n", StandardCharsets.UTF_8);

        String memory = loader(6).load(spec(project)).get(0);

        assertTrue(memory.contains("一二三四五"), memory);
        assertFalse(memory.contains("【已截断】"), memory);
    }

    private WorkspaceSpec spec(Path project) {
        return new MxcWorkspaceSpec(project.toString());
    }
}