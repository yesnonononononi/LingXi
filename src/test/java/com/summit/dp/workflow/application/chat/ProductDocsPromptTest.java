package com.summit.dp.workflow.application.chat;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 产品文档段的契约测试。
 *
 * <p>这一段解决的具体问题：用户问「这个功能怎么用」时，模型手上没有文档只能靠印象编，
 * 或者反过来得让用户每次手动贴文档路径。所以本段必须点名位置，不许写成「请参考文档」这种空话。</p>
 */
class ProductDocsPromptTest {

    @Test
    void sectionNamesTheConcreteDocsLocation() {
        String section = new ProductDocsPrompt().load();
        assertTrue(section.startsWith("# 产品文档"), "段落要有独立标题，便于在整段提示词里定位");
        assertTrue(section.contains("/docs"), "必须给出应用内的 /docs 路径");
        assertTrue(section.contains("extension-packs-guide.html"), "要给一个能直接照着读的具体文件");
        assertTrue(section.contains("docs"), "必须给出本机镜像目录，文件工具按它读绝对路径");
    }

    /** 「先读文档」是本段存在的理由，写成软建议就等于没写。 */
    @Test
    void sectionTellsTheModelToReadDocsBeforeAnswering() {
        String section = new ProductDocsPrompt().load();
        assertTrue(section.contains("先读"), "必须要求先读文档再回答产品问题");
        assertTrue(section.contains("不要凭印象猜"), "必须明确禁止凭印象编造产品行为");
    }

    /** 缺文档时编造比说不知道更糟：客户端版本可能确实没带这份文档。 */
    @Test
    void sectionTellsTheTruthWhenDocsAreMissing() {
        String section = new ProductDocsPrompt().load();
        assertTrue(section.contains("如实告诉用户当前版本没有这份文档"), "缺文档时必须如实说明，不许编");
        assertTrue(section.contains("以实现为准"), "文档与实现冲突时要以实现为准，否则会照着过期文档误导用户");
    }

    /**
     * 历史包名已废弃：提示词里一旦出现，模型会把过期目录名当事实抄给用户。
     * 这条断言是把「彻底舍弃」变成可执行契约 —— 光靠人记着不改，迟早写回去。
     */
    @Test
    void sectionDoesNotMentionTheRetiredPackageName() {
        String section = new ProductDocsPrompt().load();
        assertFalse(section.toLowerCase().contains("aether"),
                "历史包名已废弃，提示词里不许再出现，否则会引导模型去猜过期路径");
        assertTrue(section.contains("%APPDATA%"), "但要保留「用户数据目录在 %APPDATA% 下」这个事实");
        assertTrue(section.contains("以应用名命名"), "改写成按运行中的应用名推导，避免名字漂移后过期");
    }

    /** 尾换行会在 String.join("\n\n", ...) 里多出一个空行，段与段之间就会拉开。 */
    @Test
    void sectionHasNoTrailingBlankLine() {
        String section = new ProductDocsPrompt().load();
        assertFalse(section.endsWith("\n"), "段落末尾不能带换行");
        assertFalse(section.isBlank(), "段落不能为空，否则等于没注入");
    }
}
