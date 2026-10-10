package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.toolcall.application.service.ToolCallReadinessService;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.agent.infrastructure.runtime.SubExecutionLifecycle;
import com.summit.dp.turn.application.service.ChatTurnService;
import org.springframework.beans.factory.ObjectProvider;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 测试只替换无关模块，执行仓储与指定轮次服务保持真实实现。 */
public final class ExecutionRepositoryTestFactory {
    private ExecutionRepositoryTestFactory() {
    }

    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper) {
        return create(mapper, objectMapper, mock(ChatTurnService.class));
    }

    public static LocalExecutionRepository create(ExecutionMapper mapper, ObjectMapper objectMapper,
                                                 ChatTurnService chatTurnService) {
        return new LocalExecutionRepository(mapper, objectMapper,
                provider(mock(ToolCallReadinessService.class)), provider(mock(ToolCallService.class)),
                provider(mock(SubExecutionLifecycle.class)), provider(mock(SessionAggregateService.class)),
                provider(chatTurnService));
    }

    @SuppressWarnings("unchecked")
    public static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}
