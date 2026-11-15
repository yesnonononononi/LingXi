package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/**
 * 动态上下文（每轮背景块）的按段拆分：MCP 摘要 / 技能列表 / 记忆正文 / 任务清单。
 *
 * <p>它只解释「整块里各段占多少」，<b>各段之和不等于整块</b>：分词会跨段边界合并、
 * 段标题不属于任何一段，权威值仍是 {@code DYNAMIC_CONTEXT} 分项。</p>
 */
@Data
@Builder
public class TokenAuditContextSectionVO {

    /** 段类名，与框架 {@code ContextSectionKind} 同名：{@code MCP} / {@code SKILL} / {@code MEMORY} / {@code TASK}。 */
    private String kind;
    /**
     * 该段的 token 数；同一段类出现多块时已由后端合并求和。
     *
     * <p>合并后的比例不再对应任何单段，因此本 VO <b>不提供 ratio</b>，避免前端画出对不上的百分比。</p>
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer tokens;
}
