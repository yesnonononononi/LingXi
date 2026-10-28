package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

/**
 * 删除以权威清单标识定位，完成剩余步骤必须显式确认。
 *
 * <p>删除是软删，重复删除返回既有删除事实，不会物理清除历史。</p>
 */
@Data
public class DeleteChecklistArgument {

    private Long checklistId;
    private boolean completeOpenSteps;
}
