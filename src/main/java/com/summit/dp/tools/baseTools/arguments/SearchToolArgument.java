package com.summit.dp.tools.baseTools.arguments;

import lombok.Data;

/** 参数：按关键字模糊检索本次执行可调用的工具。 */
@Data
public class SearchToolArgument {
    /** 关键字，匹配工具名与描述；为空时等价于列出全部可用工具。 */
    private String keyword;
}
