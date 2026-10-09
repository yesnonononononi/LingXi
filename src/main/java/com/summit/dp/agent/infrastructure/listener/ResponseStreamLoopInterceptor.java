package com.summit.dp.agent.infrastructure.listener;

import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.dp.agent.application.service.ResponseStreamState;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** 工具并发执行前固定请求位置，不能拿完成顺序代替模型请求顺序。 */
@Component
@RequiredArgsConstructor
public class ResponseStreamLoopInterceptor implements LoopInterceptor {
    private final ResponseStreamState responseStreamState;

    @Override
    public int order() {
        return -850;
    }

    @Override
    public boolean catchErr() {
        return false;
    }

    @Override
    public InterceptorResult onAfterModelInvoke(LoopContext context, ChatResponseEntity response) {
        responseStreamState.registerTools(context.execution().getId(), context.execution().eventMetaData(), response);
        return InterceptorResult.NONE;
    }
}
