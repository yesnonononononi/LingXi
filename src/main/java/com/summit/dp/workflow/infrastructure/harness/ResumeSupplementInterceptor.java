package com.summit.dp.workflow.infrastructure.harness;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.workflow.application.input.InputInjectionStage;
import com.summit.dp.workflow.application.input.ResumeSupplementChannel;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 恢复补充的薄拦截器：只声明框架扩展点的两个契约（顺序、失败语义），实现全在通道里。
 *
 * <p><b>为什么保留这个壳</b>：规范要求框架扩展点一个模块一个实现。把三个模块合成一个拦截器，
 * {@code catchErr()} 就只能取一个值 —— 本模块要求 {@code false}（读不出补充要求就让整轮失败，
 * 吞掉等于让用户追加的要求静默消失）。</p>
 *
 * <p>顺序与 {@link ResumeSupplementChannel#ORDER} 同源，避免两处各写一个数字后漂移。</p>
 */
@Component
@RequiredArgsConstructor
public class ResumeSupplementInterceptor implements LoopInterceptor {

    private final ResumeSupplementChannel channel;

    @Override
    public int order() {
        return ResumeSupplementChannel.ORDER;
    }

    @Override
    public boolean catchErr() {
        return false;
    }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {
        Execution execution = context.getLoopMessages().getExecution();
        // 门禁为假表示「已证明没有新补充」：连 turn 与消息两次查询都不发。
        // 证明不了时（冷启动、版本表里没有这个执行）必须回退查库一次，不能跳过注入。
        if (!channel.mightHavePending(execution)) {
            return InterceptorResult.NONE;
        }
        List<SessionMessage> items = channel.pollPendingItems(execution);
        if (items.isEmpty()) {
            return InterceptorResult.NONE;
        }
        context.appendMessage(channel.toModelMessages(execution, items, InputInjectionStage.LOOP));
        channel.markConsumed(execution, items);
        return InterceptorResult.NONE;
    }
}

