package com.summit.dp.workflow.application.chat;

import org.junit.jupiter.api.Test;

import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 渲染语法段的契约测试：这一段是前后端的共同约定，写错等于让模型照着错的写法输出。
 */
class RenderSyntaxPromptTest {

    /**
     * 示例链接必须和前端 {@code utils/localFileLink.ts} 认的形状一致：
     * 前导斜杠 + 盘符 + 行号。前端那条正则只认绝对路径，示例写错模型就会照着写错。
     */
    private static final Pattern LOCAL_FILE_LINK_EXAMPLE = Pattern.compile("\\[[^\\]]+\\]\\(/[A-Za-z]:/[^)\\s]+:\\d+\\)");

    @Test
    void sectionTeachesEveryProductRenderSyntax() {
        String section = new RenderSyntaxPrompt().load();
        assertTrue(section.startsWith("# 产品渲染语法"), "段落要有独立标题，便于在整段提示词里定位");
        assertTrue(section.contains("## 本地文件链接"), "必须写明本地文件链接语法");
        assertTrue(section.contains("## Mermaid 图表"), "必须写明 Mermaid 围栏");
        assertTrue(section.contains("## 代码块"), "必须写明代码块围栏");
        assertTrue(section.contains("```mermaid"), "Mermaid 必须给出可直接抄的围栏写法");
        assertTrue(section.contains("定位到该行"), "要说明点击后会发生什么，否则模型没动机去用");
    }

    @Test
    void localFileLinkExampleMatchesTheSyntaxTheFrontendParses() {
        String section = new RenderSyntaxPrompt().load();
        assertTrue(LOCAL_FILE_LINK_EXAMPLE.matcher(section).find(),
                "示例链接必须是「/盘符/路径:行号」这种前端认得的绝对路径");
        assertTrue(section.contains("绝对路径"), "必须强调只能是绝对路径");
        assertTrue(section.contains("%20"), "路径含空格要用 %20，否则 Markdown 解析不出链接");
        assertTrue(section.contains("不要凭印象编造"), "必须禁止编造路径与行号");
    }

    @Test
    void sectionDoesNotLeakImplementationDetails() {
        String section = new RenderSyntaxPrompt().load();
        // 前端类名与属性名是实现细节，写进提示词只会诱导模型去猜 DOM。
        assertFalse(section.contains("data-local-file"), "不应把前端属性名写进提示词");
        assertFalse(section.contains("lx-local-file"), "不应把前端类名写进提示词");
    }
}
