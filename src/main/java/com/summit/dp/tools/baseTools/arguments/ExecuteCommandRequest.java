package com.summit.dp.tools.baseTools.arguments;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class ExecuteCommandRequest  {
    /** 参数键单一真源：模型下发的意图字段，进工具展示文案与卡片载荷。 */
    public static final String INTENTION = "intention";

    private String command;
    private String intention;
}
