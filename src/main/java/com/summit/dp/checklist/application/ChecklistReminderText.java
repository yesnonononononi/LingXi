package com.summit.dp.checklist.application;

import com.summit.dp.checklist.domain.model.ChecklistRules;

import java.util.List;

/**
 * 提醒文案渲染。
 *
 * <p>为什么单独成类：文案要带上稳定 stepId（模型必须用 ID 指对步骤）、
 * 要列出序号与内容，还要受条数上限约束。把它塞进拦截器会让一个只该做决策翻译的类
 * 变成文案工坊，也就没法单独验证「大清单不会撑爆上下文」。</p>
 */
public final class ChecklistReminderText {

    /** 单条内容的展示上限：内容本身最多 500 字，提醒里只保留开头，避免一行挤占整段上下文。 */
    private static final int CONTENT_PREVIEW = 120;

    private ChecklistReminderText() {
    }

    /** 渲染「你还有没做完的步骤」提醒。 */
    public static String render(ReminderDecision decision) {
        ChecklistVO snapshot = decision.checklist();
        if (snapshot == null) {
            return "执行清单仍有未处理的步骤，请先用 update_checklist_step 如实标记结果。";
        }
        StringBuilder text = new StringBuilder();
        text.append("你在这一轮表示已完成，但本次任务的执行清单「").append(snapshot.getTitle())
                .append("」仍有待处理步骤：\n");
        int listed = 0;
        for (ChecklistVO.StepVO step : decision.pendingSteps()) {
            if (listed >= ChecklistRules.MAX_REMIND_STEPS) {
                text.append("- 另有 ").append(decision.pendingSteps().size() - listed)
                        .append(" 个步骤未逐条列出，请用清单快照核对\n");
                break;
            }
            text.append("- 序号 ").append(step.getSeq())
                    .append(" | stepId ").append(step.getStepId())
                    .append(" | ").append(preview(step.getContent()))
                    .append('\n');
            listed++;
        }
        text.append("请逐项如实处理：真的做完用 update_checklist_step 标记 COMPLETED，失败标 FAILED，决定不做标 SKIPPED。\n")
                .append("不要为了清空清单把没有完成的工作标成成功；需要改步骤内容或增删步骤请用 modify_checklist。\n")
                .append("关联标识：checklistId=").append(snapshot.getChecklistId())
                .append(", progressVersion=").append(snapshot.getProgressVersion());
        return text.toString();
    }

    /** 渲染清单上下文注入：让新执行与压缩后的模型拿到清单标识与稳定 stepId。 */
    public static String renderContext(ChecklistVO snapshot) {
        StringBuilder text = new StringBuilder();
        text.append("本次会话已有执行清单「").append(snapshot.getTitle())
                .append("」（checklistId=").append(snapshot.getChecklistId())
                .append("，进度版本=").append(snapshot.getProgressVersion()).append("）：\n");
        for (ChecklistVO.StepVO step : snapshot.sortedSteps()) {
            text.append("- 序号 ").append(step.getSeq())
                    .append(" | stepId ").append(step.getStepId())
                    .append(" | ").append(step.getStatus())
                    .append(" | ").append(preview(step.getContent()))
                    .append('\n');
        }
        text.append("开始处理步骤前用 update_checklist_step 标记 IN_PROGRESS，完成后立刻如实标记结果；这份清单不是审批计划，不产生审批卡片。");
        return text.toString();
    }

    private static String preview(String content) {
        if (content == null) {
            return "";
        }
        return content.length() <= CONTENT_PREVIEW ? content : content.substring(0, CONTENT_PREVIEW) + "…";
    }
}
