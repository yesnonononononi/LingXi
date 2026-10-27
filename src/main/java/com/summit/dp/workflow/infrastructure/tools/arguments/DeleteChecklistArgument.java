package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

/**
 * delete_checklist 的参数：只接受权威清单标识。
 *
 * <p>删除是软删，重复删除返回既有删除事实，不会物理清除历史。</p>
 */
@Data
public class DeleteChecklistArgument {

    private Long checklistId;
}
