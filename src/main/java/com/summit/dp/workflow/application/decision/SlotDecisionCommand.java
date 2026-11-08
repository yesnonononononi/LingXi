package com.summit.dp.workflow.application.decision;

import java.util.List;
import java.util.Map;

/**
 * 一次决策提交的统一输入。
 *
 * <p><b>为什么用 sealed 而不是「按 Class 注册表查策略」</b>：决议形态只有三种，
 * 且每种的处理方式在编译期就已知。密封加穷尽 switch 让「新增一种决议」变成编译错误，
 * 而不是运行期找不到注册项。</p>
 */
public sealed interface SlotDecisionCommand
        permits ImmediateDecision, CommandDecision, ChoiceBatchDecision {

    /** 会话 id；{@code null} 表示本次不校验归属。 */
    Long conversationId();

    /** 决策命令身份；v1 没有这个概念，为 {@code null}。 */
    String commandId();

    /** 请求摘要：同 commandId 不同摘要即命令冲突；v1 为 {@code null}。 */
    String digest();

    /**
     * 需要读取并校验的卡片标识。
     *
     * <p>多选批量是整组，其余单卡。首元素必须是最先定位到的那张卡片。</p>
     */
    List<String> cardIds();

    /**
     * 客户端看到的卡片版本；为空表示本入口不做版本校验（v1）。
     */
    Map<String, Long> expectedVersions();

    /** 恢复意图由谁登记。 */
    ResumeIntent resumeIntent();
}
