package com.summit.dp.workflow.application.turn;

import com.summit.dp.workflow.application.pending.PendingTaskDispatcher;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/**
 * 待发送队列的接力入口：上一轮正常结束后把该会话最早一条排队消息发出去。
 *
 * <p><b>order 最小</b>：用户的显式输入优先于邮件 / 后台任务这类自动续跑，
 * 后面的监听器看到「还有待发送任务」会自己让位（{@code PendingTaskService#deferAutomatic}）。</p>
 *
 * <p>用 {@link ObjectProvider} 取派发器是为了断开启动期循环依赖：
 * 派发要提交新执行，执行器又要发布本事件。</p>
 */
@Component
@RequiredArgsConstructor
public class PendingTurnPostEndListener implements TurnPostEndListener {

    public static final int ORDER = -900;

    private final ObjectProvider<PendingTaskDispatcher> dispatchers;

    @Override
    public int order() {
        return ORDER;
    }

    @Override
    public void onTurnEnded(TurnPostEndContext context) {
        // 只有正常完成才接力：失败、被停止、挂起时上一轮并没有成为「可以往下走」的事实。
        if (!context.completed()) {
            return;
        }
        PendingTaskDispatcher dispatcher = dispatchers.getIfAvailable();
        if (dispatcher == null) {
            return;
        }
        dispatcher.relay(context.sessionId());
    }
}
