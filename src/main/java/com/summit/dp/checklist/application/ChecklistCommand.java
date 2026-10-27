package com.summit.dp.checklist.application;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 清单写操作的统一入参。
 *
 * <p>四个工具的参数形状不同，但落点都是同一套聚合事务，所以用一条命令承载；
 * 每个静态工厂只填自己那几个字段，读起来等价于四个专用命令，却不需要四个几乎相同的类。</p>
 *
 * <p>会话归属与执行标识<b>不</b>从这里进来：它们只由工具执行上下文解析，
 * 模型既不能指定也不能覆盖。</p>
 */
@Data
@Builder
public class ChecklistCommand {

    /** 会话标识：由工具执行上下文解析后填入 */
    private Long sessionId;
    /** 创建者 Agent：仅记录 */
    private Long agentId;

    /** 新建清单的标题 */
    private String title;
    /** 新建清单的步骤内容，按数组顺序 */
    private List<String> steps;

    /** 目标清单标识；为空时按会话内当前活动清单定位 */
    private Long checklistId;
    /** 目标步骤标识 */
    private Long stepId;
    /** 目标状态，只接受 COMPLETED / FAILED / SKIPPED */
    private String status;

    /** 修改后的新标题，null 表示不改 */
    private String newTitle;
    /** 步骤内容补丁：显式给出 stepId → 新内容 */
    private List<StepContent> stepContents;
    /** 追加的新步骤内容 */
    private List<String> addedSteps;
    /** 要删除的步骤标识 */
    private List<Long> removedStepIds;
    /** 修改后的完整顺序；为空表示沿用现有顺序 */
    private List<Long> orderedStepIds;

    /** 步骤内容补丁项：标识稳定，文案可改。 */
    public record StepContent(Long stepId, String content) {
    }

    /** 新建清单。 */
    public static ChecklistCommand create(long sessionId, Long agentId, String title, List<String> steps) {
        return ChecklistCommand.builder()
                .sessionId(sessionId).agentId(agentId).title(title).steps(steps)
                .build();
    }

    /** 更新一个步骤的终态。 */
    public static ChecklistCommand updateStep(long sessionId, Long checklistId, Long stepId, String status) {
        return ChecklistCommand.builder()
                .sessionId(sessionId).checklistId(checklistId).stepId(stepId).status(status)
                .build();
    }

    /** 结构修改补丁。 */
    public static ChecklistCommand modify(long sessionId, Long checklistId, String newTitle,
                                          List<StepContent> stepContents, List<String> addedSteps,
                                          List<Long> removedStepIds, List<Long> orderedStepIds) {
        return ChecklistCommand.builder()
                .sessionId(sessionId).checklistId(checklistId).newTitle(newTitle)
                .stepContents(stepContents).addedSteps(addedSteps)
                .removedStepIds(removedStepIds).orderedStepIds(orderedStepIds)
                .build();
    }

    /** 软删清单。 */
    public static ChecklistCommand delete(long sessionId, Long checklistId) {
        return ChecklistCommand.builder()
                .sessionId(sessionId).checklistId(checklistId)
                .build();
    }
}
