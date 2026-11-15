package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

import java.util.List;

/** 已包含在消息分项中的归因明细。 */
@Data
@Builder
@JsonInclude(JsonInclude.Include.NON_NULL)
public class TokenAuditContextAttributionVO {

    /** 记忆正文 token（不含标题与消息分帧）；null 表示未知。 */
    private Integer memoryTokens;
    /**
     * 动态上下文的按段拆分（MCP / SKILL / MEMORY / TASK）。
     *
     * <p>框架没切段时为空集合：那是「框架没给」，不是「各段为 0」。
     * 其中 {@code MEMORY} 段与 {@link #memoryTokens} 同源，展示时二选一，绝不并排累加。</p>
     */
    private List<TokenAuditContextSectionVO> sections;
}
