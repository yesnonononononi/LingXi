package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

/**
 * 审计查询以权威清单标识定位，不提供「查最近一份」的捷径。
 *
 * <p>口径与写入口一致：归属只认会话，跨会话一律拒绝；已软删的历史仍可读取。</p>
 */
@Data
public class GetChecklistArgument {

    private Long checklistId;
}
