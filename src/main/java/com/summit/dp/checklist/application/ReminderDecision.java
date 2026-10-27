package com.summit.dp.checklist.application;

import java.util.List;

/**
 * 一次自然收尾的提醒判定结果。
 *
 * <p>拦截器不做状态判断：它只把这里的结论翻译成 {@code NONE} 或显式续轮，
 * 这样「首次提醒 / 额度用尽 / 没有清单」这些规则只有一份实现，也就只有一份测试。</p>
 *
 * @param outcome      结论
 * @param checklist    判定时的权威快照，可能为 {@code null}（无活动清单时）
 * @param pendingSteps 仍待处理的步骤快照，顺序按 seq 升序
 * @param reason       给日志与调用方看的中文说明
 */
public record ReminderDecision(
        Outcome outcome,
        ChecklistVO checklist,
        List<ChecklistVO.StepVO> pendingSteps,
        String reason) {

    /** 提醒判定结论。 */
    public enum Outcome {
        /** 本会话没有活动清单：不消费额度，直接放行 */
        NO_ACTIVE_CHECKLIST,
        /** 没有待处理步骤：清单已收口，放行 */
        NOTHING_PENDING,
        /** 首次提醒：额度已占用，需要再来一轮模型调用 */
        REMINDED,
        /** 未确认投递或已接管终结执行的提醒，需要有界重放。 */
        REPLAYED,
        /** 额度已用尽仍无实际推进：清单置 UNFINISHED 后放行 */
        EXHAUSTED
    }

    public static ReminderDecision noActiveChecklist() {
        return new ReminderDecision(Outcome.NO_ACTIVE_CHECKLIST, null, List.of(), "当前会话没有活动清单");
    }

    public static ReminderDecision nothingPending(ChecklistVO snapshot) {
        return new ReminderDecision(Outcome.NOTHING_PENDING, snapshot, List.of(), "清单已没有待处理步骤");
    }

    public static ReminderDecision reminded(ChecklistVO snapshot, List<ChecklistVO.StepVO> pendingSteps) {
        return new ReminderDecision(Outcome.REMINDED, snapshot, pendingSteps, "首次提醒：仍有待处理步骤");
    }

    public static ReminderDecision exhausted(ChecklistVO snapshot, String reason) {
        return new ReminderDecision(Outcome.EXHAUSTED, snapshot, List.of(), reason);
    }

    public static ReminderDecision replayed(ChecklistVO snapshot, List<ChecklistVO.StepVO> pendingSteps) {
        return new ReminderDecision(Outcome.REPLAYED, snapshot, pendingSteps, "提醒投递未确认或执行已接续，重放一次");
    }

    /** 是否需要再来一轮模型调用。 */
    public boolean requiresAnotherRound() {
        return outcome == Outcome.REMINDED || outcome == Outcome.REPLAYED;
    }
}
