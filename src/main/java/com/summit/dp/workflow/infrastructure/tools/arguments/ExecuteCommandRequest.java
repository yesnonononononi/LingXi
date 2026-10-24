package com.summit.dp.workflow.infrastructure.tools.arguments;

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
    private boolean background;
    /** 本次执行要求的目标解释器 id（cmd/pwsh/powershell/bash/sh/zsh）；为空表示沿用工作空间默认。 */
    private String shell;
}
