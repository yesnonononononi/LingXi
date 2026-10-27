package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

/**
 * update_checklist_step 的参数。
 *
 * <p>{@code checklistId} 可选：给出时按标识定位并校验归属，省略时用当前会话的活动清单。
 * 步骤标识必须来自工具上一次返回的权威快照，不接受临时自造 ID。</p>
 */
@Data
public class UpdateChecklistStepArgument {

    private Long checklistId;
    private Long stepId;
    /** COMPLETED / FAILED / SKIPPED */
    private String status;
}
