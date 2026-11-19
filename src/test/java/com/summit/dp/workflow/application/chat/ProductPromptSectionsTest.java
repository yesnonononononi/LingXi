package com.summit.dp.workflow.application.chat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 产品事实段组装逻辑的测试。
 *
 * <p>这一段逻辑本身很薄，但它决定整段系统提示词的顺序：顺序错了，模型会先看到
 * 「构建踩坑」再看到「怎么写正文」，重要信息被压到后面。以前这个顺序散在
 * {@code BusinessSystemPromptBuilder} 的构造参数里，改一次要动多处测试的期望字符串，
 * 现在集中在这里，就该由这里把顺序钉死。</p>
 */
class ProductPromptSectionsTest {

    @Test
    void sectionsFollowTheDocumentedOrder() {
        String combined = ProductPromptSections.defaults().load();

        int renderSyntax = combined.indexOf("# 产品渲染语法");
        int productDocs = combined.indexOf("# 产品文档");
        int devEnvironment = combined.indexOf("# 后端构建环境");

        assertTrue(renderSyntax >= 0, "缺渲染语法段");
        assertTrue(productDocs >= 0, "缺产品文档段");
        assertTrue(devEnvironment >= 0, "缺后端构建环境段");
        assertTrue(renderSyntax < productDocs, "渲染语法必须排在产品文档之前：先讲怎么写正文，再讲去哪查资料");
        assertTrue(productDocs < devEnvironment, "后端构建环境排在最后：它是补充说明，不该抢占开头");
    }

    /** 段与段之间只能有一个空行分隔，多一个就是拼接口径不一致。 */
    @Test
    void sectionsAreSeparatedByExactlyOneBlankLine() {
        String combined = ProductPromptSections.defaults().load();
        assertEquals(-1, combined.indexOf("\n\n\n"), "段与段之间出现了连续空行");
        assertFalse(combined.startsWith("\n"), "整段不能以空行开头");
        assertFalse(combined.endsWith("\n"), "整段不能以空行结尾");
    }

    /** 空段必须被过滤掉，否则会留下「前一段\n\n\n\n后一段」这种空洞。 */
    @Test
    void emptySectionsAreDroppedWithoutLeavingGaps() {
        RenderSyntaxPrompt emptyRenderSyntax = new RenderSyntaxPrompt() {
            @Override
            public String load() {
                return "";
            }
        };
        ProductPromptSections sections = new ProductPromptSections(
                emptyRenderSyntax, new ProductDocsPrompt(), new DevEnvironmentPrompt());

        String combined = sections.load();
        assertFalse(combined.contains("# 产品渲染语法"), "空段不该凭空出现标题");
        assertFalse(combined.startsWith("\n\n"), "首段为空时不能留下前缀分隔符");
        assertEquals(-1, combined.indexOf("\n\n\n"), "过滤空段后不该出现连续空行");
        assertTrue(combined.startsWith("# 产品文档"), "空段被过滤后，剩下的段应顶到最前面");
    }
}
