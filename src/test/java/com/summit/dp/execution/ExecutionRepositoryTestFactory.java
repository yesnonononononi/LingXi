package com.summit.dp.execution;

import org.springframework.context.ApplicationEventPublisher;

import com.summit.dp.workflow.infrastructure.harness.ExecutionSnapshotReader;
import com.summit.dp.workflow.infrastructure.harness.LegacyExecutionSnapshotAdapter;

import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
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
        return new LocalExecutionRepository(new ExecutionCheckpointService(new ExecutionRepositoryImpl(mapper), mock(ApplicationEventPublisher.class)), objectMapper,
                provider(mock(ToolCallReadinessService.class)), provider(mock(ToolCallService.class)),
                provider(mock(SubExecutionLifecycle.class)), provider(mock(SessionContextUsageProjector.class)),
                provider(new ChatTurnLifecycleProjector(chatTurnService)), provider(mock(RuntimeEventPublisher.class)),
                new ExecutionSnapshotReader(objectMapper, new LegacyExecutionSnapshotAdapter(objectMapper, RuntimeConfigurationTestSupport.create())));
    }

    @SuppressWarnings("unchecked")
    public static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}
