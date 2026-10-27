package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

import java.util.List;

/**
 * modify_checklist 的参数：显式补丁。
 *
 * <p>「请求里没出现」不代表删除：要删就必须出现在 {@code removeStepIds} 里。
 * 这样模型少写一个字段不会静默丢步骤。</p>
 */
@Data
public class ModifyChecklistArgument {

    private Long checklistId;
    /** 新标题；为空表示不改 */
    private String newTitle;
    /** 改内容：stepId + 新文案，保留原状态 */
    private List<StepContentPatch> stepContents;
    /** 追加的新步骤内容，一律待处理 */
    private List<String> addSteps;
    /** 要删除的步骤标识 */
    private List<Long> removeStepIds;
    /** 修改完成后的完整顺序；为空表示沿用现有顺序 */
    private List<Long> orderedStepIds;

    /** 一条内容补丁。 */
    @Data
    public static class StepContentPatch {
        private Long stepId;
        private String content;
    }
}
