package com.summit.dp.workflow.infrastructure.tools.arguments;

import lombok.Data;

import java.util.List;

/**
 * create_checklist 的参数：标题 + 一次性给出的步骤内容。
 *
 * <p>步骤按数组顺序编号，不接收模型自造的步骤标识。</p>
 */
@Data
public class CreateChecklistArgument {

    private String title;
    private List<String> steps;
}
