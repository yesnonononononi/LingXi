package com.summit.dp.workflow.application.chat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 后端构建环境段的契约测试。
 *
 * <p>这段的价值全在「提前说清」，所以必须点名可观察的症状：报错原文、
 * 指错的路径形状、以及「这是环境问题」的定性。只写「注意 JAVA_HOME」等于没写。</p>
 */
class DevEnvironmentPromptTest {

    @Test
    void sectionNamesTheExactSymptomAndTheWrongPathShape() {
        String section = new DevEnvironmentPrompt().load();
        assertTrue(section.startsWith("# 后端构建环境"), "段落要有独立标题，便于在整段提示词里定位");
        assertTrue(section.contains("No such compiler 'javac'"), "必须给出报错原文，否则认不出是这个坑");
        assertTrue(section.contains("resources/backend/runtime"), "必须点出指错的路径形状");
    }

    @Test
    void sectionTellsHowToFixItAndRulesOutCodeChanges() {
        String section = new DevEnvironmentPrompt().load();
        assertTrue(section.contains("JAVA_HOME"), "必须点名 JAVA_HOME");
        assertTrue(section.contains("javac.exe"), "给出可直接执行的排查动作：看 javac.exe 在不在");
        assertTrue(section.contains("环境问题而非代码问题"), "要定性，否则有人会顺着报错去改构建配置");
        assertTrue(section.contains("jlink"), "要说清为什么自带运行时不能编译：裁剪过");
    }

    /** 尾换行会在分段拼接里多出一个空行。 */
    @Test
    void sectionHasNoTrailingBlankLine() {
        String section = new DevEnvironmentPrompt().load();
        assertFalse(section.endsWith("\n"), "段落末尾不能带换行");
        assertFalse(section.isBlank(), "段落不能为空，否则等于没注入");
    }
}
