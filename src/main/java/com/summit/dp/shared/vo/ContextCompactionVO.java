package com.summit.dp.shared.vo;

import com.fasterxml.jackson.annotation.JsonInclude;
import lombok.Builder;
import lombok.Data;

/**
 * 手工压缩（{@code /compact}）的回执：压缩前后用量 + 重算后的审计快照。
 *
 * <p><b>为什么把两份数据合成一个回执</b>：用户按一次按钮想看的两件事就是「现在占多少」
 * 与「这堆 token 到底花在哪」。审计面板单独走推送只能覆盖第二种，而压缩是用户显式动作，
 * 结果必须同步返回 —— 否则请求成功、界面靠等推送，失败时用户无从判断到底动没动。</p>
 *
 * <p>{@code compacted == false} 时 {@code audit} 为 null：那一刻上下文<b>没有</b>被改写，
 * 把上一份快照当结果下发会让「压缩后还是这么大」成为完全合理的错觉。</p>
 *
 * <p>token 计数一律 {@link Integer}（与本工程「只有 ID 用 Long」的序列化约定一致）；
 * 可空字段 {@link JsonInclude.Include#NON_NULL}，null 语义是「不知道」而不是 0。</p>
 */
@Data
@Builder
public class ContextCompactionVO {

    /** 上下文是否真的被重写；{@code false} 表示摘要不可用或无需压缩。 */
    private boolean compacted;
    /** 压缩前已用 token；null 表示模型未配置上下文窗口。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer tokensBefore;
    /** 压缩后已用 token；{@code compacted == false} 时不重复下发。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private Integer tokensAfter;
    /**
     * 是否成功重算并落库了新的审计快照。
     *
     * <p>{@code false} 只表示「审计没刷新」（框架审计开关关闭或审计自身失败），
     * 与压缩是否成功无关 —— 两者失败原因不同，不能共用一个标记。</p>
     */
    private boolean auditRefreshed;
    /** 面向用户的说明文案（成功摘要 / 拒绝原因之外的补充信息）。 */
    private String message;
    /** 重算后的会话级审计快照；{@code compacted == false} 时为 null。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private SessionTokenAuditVO audit;
}
