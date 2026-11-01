package com.summit.dp.workflow.application.input;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.util.ArrayList;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class InputNoticeReporterTest {
    @Test void persistedBatchNoticeIsVisibleAndNotReportedAgainAfterReload() throws Exception {
        ExecutionRepository executions = mock(ExecutionRepository.class);
        ChatTurnRepository turns = mock(ChatTurnRepository.class);
        ChatTurn turn = ChatTurn.builder().id(20L).sessionId(10L).executionId(100L).build();
        turn.recordFailureReason("原始失败原因");
        when(turns.findByExecutionId(100L)).thenReturn(Optional.of(turn));
        ObjectMapper json = new ObjectMapper().findAndRegisterModules();
        AtomicReference<byte[]> saved = new AtomicReference<>();
        doAnswer(call -> { saved.set(json.writeValueAsBytes(call.getArgument(0))); return null; })
                .when(executions).save(any());
        InputNoticeReporter reporter = new InputNoticeReporter(new StaticListableBeanFactory(Map.of("executions", executions))
                .getBeanProvider(ExecutionRepository.class), turns);
        Execution execution = Execution.builder().id("100").executionState(ExecutionState.FAILED)
                .messages(new ArrayList<>()).agentRequest(AgentRequest.builder().runtimeParameters(
                        AgentRuntimeParameters.builder().attributes(Map.of(ExecutionAttributes.SESSION_ID, "10")).build()).build()).build();
        reporter.report(execution, "same-batch", "执行失败");
        reporter.report(json.readValue(saved.get(), Execution.class), "same-batch", "执行失败");
        verify(turns).updateById(turn, 10L);
        verify(executions).save(any());
        assertTrue(turn.getErrorReason().contains("原始失败原因"));
        assertTrue(turn.getErrorReason().contains(InputNoticeReporter.PREFIX));
        assertEquals(ExecutionState.FAILED, execution.getExecutionState());
    }
}
