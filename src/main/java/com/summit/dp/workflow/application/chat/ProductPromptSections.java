package com.summit.dp.workflow.application.chat;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.stream.Collectors;

/**
 * 产品事实段的收口点：渲染语法、产品文档、后端构建环境，按固定顺序拼成一段。
 *
 * <p>为什么要有这个类：这几段都是「产品/环境是什么样」的客观事实，与用户偏好无关，
 * 也都不该塞进用户可编辑的 {@code lingxi.system-prompt}。以前它们作为构造参数逐个
 * 传进 {@link BusinessSystemPromptBuilder}，每加一段就要改构造器签名、改多处测试的
 * 期望字符串 —— 加第三段的时候已经很难看了。</p>
 *
 * <p>收成集合后，新增一段只需要在 {@link #load()} 的组装里加一个元素，构建器的签名不再变动。
 * 顺序也集中在这里：渲染语法 → 产品文档 → 后端构建环境，由近及远，
 * 先讲「怎么写正文」，再讲「去哪查资料」，最后讲「构建会踩什么坑」。</p>
 */
@Component
public class ProductPromptSections {

    private final RenderSyntaxPrompt renderSyntaxPrompt;
    private final ProductDocsPrompt productDocsPrompt;
    private final DevEnvironmentPrompt devEnvironmentPrompt;

    @Autowired
    public ProductPromptSections(RenderSyntaxPrompt renderSyntaxPrompt,
                                 ProductDocsPrompt productDocsPrompt,
                                 DevEnvironmentPrompt devEnvironmentPrompt) {
        this.renderSyntaxPrompt = renderSyntaxPrompt;
        this.productDocsPrompt = productDocsPrompt;
        this.devEnvironmentPrompt = devEnvironmentPrompt;
    }

    /** 产品默认组合：委派链路与非 Spring 场景直接用它，不必自己装配三段。 */
    public static ProductPromptSections defaults() {
        return new ProductPromptSections(new RenderSyntaxPrompt(), new ProductDocsPrompt(), new DevEnvironmentPrompt());
    }

    /** 空段不产生分隔符，避免连续空行。 */
    public String load() {
        List<String> sections = List.of(
                renderSyntaxPrompt.load(),
                productDocsPrompt.load(),
                devEnvironmentPrompt.load()
        );
        return sections.stream().filter(section -> !section.isEmpty()).collect(Collectors.joining("\n\n"));
    }
}
