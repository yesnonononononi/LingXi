package com.summit.dp.workflow.application.decision;

import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.shared.vo.ToolCallVO;

/**
 * 入口契约：把「同一个不变量」在本入口该用什么方式表达交给入口自己决定。
 *
 * <p><b>为什么需要它</b>：v1 与 v2 的判定顺序和冲突语义是<b>既有对外契约</b> ——
 * v1 回 {@code ClientException}（JSON 错误体）、对已决卡片回一个立即完成的流；
 * v2 回 {@code DecisionConflictException}（409 + 机器可判别错误码）。
 * 引擎只保留一份判定顺序，把「怎么表达」下推给契约，就不会为了统一而改掉任何一边的行为。</p>
 *
 * <p>实现只允许两个：{@link ReactiveDecisionContract}（v1）与
 * {@link VersionedDecisionContract}（v2 / 多选批量）。</p>
 */
public interface DecisionEntryContract {

    /** 入口标识，仅用于日志与排查。 */
    String label();

    /**
     * 冲突用什么异常表达。
     *
     * @param code    机器可判别错误码；v1 不消费
     * @param message 面向用户的文案
     * @param view    卡片最新视图，可为空
     */
    RuntimeException conflict(DecisionErrorCode code, String message, ToolCallVO view);

    /**
     * 执行不在可决策态时的异常。
     *
     * @param terminal {@code true} 表示执行已终结；{@code false} 表示尚未暂停
     */
    RuntimeException executionUnavailable(ToolCall card, boolean terminal);

    /**
     * 卡片本来就不待决时的处理。
     *
     * <p>v1 返回幂等 no-op 回执（保持「已处理就返回一个立即完成的流」的旧行为）；
     * v2 直接抛「已有结论」，并带上实际最新视图。</p>
     */
    DecisionReceipt unavailable(ToolCall card, String message);

    /**
     * 读取执行之前的入口受理闸门（v1 额外拦「准备中」）。
     *
     * @param card 锁内重读到的卡片
     */
    void admitCard(ToolCall card);

    /**
     * 读取执行之前的入口闸门（v1 额外拦「执行仍活跃」与「该形态无需人工审批」）。
     *
     * @param card 锁内重读到的卡片
     */
    void admitExecution(ToolCall card);
}
