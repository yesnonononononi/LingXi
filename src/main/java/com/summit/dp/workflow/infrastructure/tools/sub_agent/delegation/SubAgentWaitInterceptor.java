package com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.dp.workflow.application.input.InputResolver;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** 先读依赖再查输入，交付发布与依赖解除的交错才不会漏读。 */
@Component
@RequiredArgsConstructor
public class SubAgentWaitInterceptor implements LoopInterceptor {
    private final InputResolver inputs;

    @Override public int order() { return -700; }
    @Override public boolean catchErr() { return false; }

    @Override
    public InterceptorResult onBeforeComplete(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        boolean open = inputs.hasOpenDependency(execution);
        if (inputs.hasPendingItems(execution)) {
            return InterceptorResult.of(LoopResult.continueLoop(), false);
        }
        return open ? InterceptorResult.of(LoopResult.suspended("等待外部输入"), false)
                : InterceptorResult.NONE;
    }
}
