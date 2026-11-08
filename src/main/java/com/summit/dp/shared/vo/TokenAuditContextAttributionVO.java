package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/**
 * 上下文归因明细视图（设计稿的「其中：记忆正文 / 用户附件」）。
 *
 * <p><b>这是归因明细，不得累加进分类合计</b>：{@code memoryTokens} 已包含在 SYSTEM 分项里，
 * {@code attachmentTokens} 已包含在 USER 分项里（框架 {@code OtherTokens} 的语义）。
 * 把它们加到四类之和会重复计数，加到请求开销会破坏 {@code total = messages + requestOverhead}。</p>
 *
 * <p>两个字段都可空：{@code null} 语义是「不知道」（框架未给出 / 该项审计失败），
 * 与 0 的区别必须能被前端区分 —— 0 表示「确实没有记忆 / 附件开销」。</p>
 *
 * <p>token 计数一律 {@link Integer}：本工程的 Jackson 全局把 {@code Long} 序列化成字符串，
 * 前端按 number 解析会把字符串当成「未知」而整行不渲染。</p>
 */
@Data
@Builder
@JsonInclude(JsonInclude.Include.NON_NULL)
public class TokenAuditContextAttributionVO {

    /** 记忆正文 token（不含标题与消息分帧）；null 表示未知。 */
    private Integer memoryTokens;
    /** 用户消息中的非文本内容 token（不含消息分帧）；null 表示未知。 */
    private Integer attachmentTokens;
}
