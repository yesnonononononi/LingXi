package com.summit.dp.session;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.*;

/** 用量缺失不能覆盖历史快照，子会话用量必须写入自身会话。 */
class SessionExecutionContextUsageTest {
    private final SessionRepository repository = mock(SessionRepository.class);
    private final SessionAggregateService service = new SessionAggregateService(repository,
            mock(MessageRepository.class), mock(ToolCallRepository.class), mock(ModelContextService.class),
            mock(SessionContextRepository.class));

    @Test
    void storesMetricInExecutionSessionInsteadOfRootSession() {
        Session session = Session.builder().id(200L).rootSessionId(100L).build();
        when(repository.findById(200L)).thenReturn(Optional.of(session));
        Execution execution = execution(Map.of(ExecutionAttributes.SESSION_ID, "200"),
                new ContextUsageMetric(300, 1000, 0.3));

        service.saveExecutionContextUsage(execution);

        assertEquals(300L, session.getContextTokenCount());
        assertEquals(1000, session.getContextMaxTokens());
        assertEquals(0.3, session.getContextRatio());
        verify(repository).findById(200L);
        verify(repository).updateById(session);
        verifyNoMoreInteractions(repository);
    }

    @Test
    void missingMetricOrSessionDoesNotWriteFabricatedUsage() {
        service.saveExecutionContextUsage(null);
        service.saveExecutionContextUsage(execution(Map.of(ExecutionAttributes.SESSION_ID, "200"), null));
        service.saveExecutionContextUsage(execution(Map.of(), new ContextUsageMetric(300, 1000, 0.3)));
        verifyNoInteractions(repository);
    }

    private static Execution execution(Map<String, Object> attributes, ContextUsageMetric metric) {
        AgentRequest request = AgentRequest.builder().runtimeParameters(
                AgentRuntimeParameters.builder().attributes(attributes).build()).build();
        return Execution.builder().id("9001").agentRequest(request).contextUsageMetric(metric).build();
    }
}
