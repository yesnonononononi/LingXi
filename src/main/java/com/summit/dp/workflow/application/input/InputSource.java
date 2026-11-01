package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;

import java.util.List;

/** 判断与注入共用待处理项查询，通知本身不代表新增输入。 */
public interface InputSource<T> {
    List<T> pendingItems(Execution execution);

    boolean hasOpenDependency(Execution execution);
}
