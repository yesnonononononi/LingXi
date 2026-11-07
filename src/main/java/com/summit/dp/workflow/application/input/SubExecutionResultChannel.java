package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 子执行结果通道：只承担「还有没有没回来的子代理」这一判定，不注入任何文本。
 *
 * <p>子代理的交付物是发给发起方的邮件，走邮件通道；这里若也注入一份就是双份上下文。
 * 但它仍然必须存在于通道体系里 —— 收尾判定要问「有没有未完结的异步依赖」，
 * 这个问题的答案必须和恢复门禁用同一份实现（{@link SubExecutionDependency}），
 * 两处各写一套判定迟早漂移：一处放行、另一处仍拦，用户看到的就是「有时能收尾、有时不能」。</p>
 */
@Component
@RequiredArgsConstructor
public class SubExecutionResultChannel implements PendingInputChannel<Void> {

    /** 排在邮件之后：交付物本身由邮件携带，这里只是「还差谁没回来」的判据。 */
    public static final int ORDER = -700;

    private final SubExecutionDependency dependency;

    @Override
    public int order() {
        return ORDER;
    }

    /** 没有可注入的条目：结果是邮件，本通道只提供依赖判定。 */
    @Override
    public List<Void> pollPendingItems(Execution execution) {
        return List.of();
    }

    @Override
    public List<String> formatForModelContext(Execution execution, List<Void> items,
                                              InputInjectionStage stage) {
        return List.of();
    }

    @Override
    public void markConsumed(Execution execution, List<Void> items) {
        // 无条目可消费。
    }

    @Override
    public boolean hasOpenAsyncDependency(Execution execution) {
        return dependency.hasUnfinishedSubExecution(execution);
    }
}
