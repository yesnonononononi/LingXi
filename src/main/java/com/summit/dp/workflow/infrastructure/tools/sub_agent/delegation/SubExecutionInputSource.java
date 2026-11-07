package com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation;

import com.summit.core.agent.Execution;
import com.summit.dp.workflow.application.input.InputSource;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/** 子执行交付归邮件来源；本来源只阻止依赖未结束时收尾。 */
@Component
@RequiredArgsConstructor
public class SubExecutionInputSource implements InputSource<Void> {
    /** 判定只有一份：恢复门禁与这里的拦截器问的是同一个问题，不能各写一套。 */
    private final SubExecutionDependency dependency;

    @Override
    public List<Void> pendingItems(Execution execution) {
        return List.of();
    }

    @Override
    public boolean hasOpenDependency(Execution execution) {
        return dependency.hasUnfinishedSubExecution(execution);
    }
}

