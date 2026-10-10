package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.service.ToolCallActionResolver;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ToolCallActionResolverTest {
    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final CardAvailabilityPolicy policy =
            new CardAvailabilityPolicy(provider(executions), provider(activity));
    private final ToolCallActionResolver resolver = new ToolCallActionResolver(policy);
    private final ObjectMapper json = new ObjectMapper();
    private final ToolCallConverter converter = new ToolCallConverter(json);

    @Test
    void preparingLegacyDelegationAndUnknownContentNeverExposeActions() throws Exception {
        JsonNode content = json.readTree("{\"text\":\"计划\"}");
        assertTrue(resolver.resolveActions(tool(ToolCallStatus.PREPARING), ToolCallKind.PLAN, content).allowedActions().isEmpty());
        // 新现实：改造前遗留的 DELEGATION 行 kind 已不可识别，解析为 null 且不抛异常；
        // 该 null 形态落进「未知形态」降级分支，同样不开放任何动作。
        ToolCallKind legacyKind = converter.resolveKind("{\"kind\":\"DELEGATION\",\"text\":\"写代码\"}");
        assertNull(legacyKind);
        assertTrue(resolver.resolveActions(tool(ToolCallStatus.PENDING), legacyKind, content).allowedActions().isEmpty());
        assertTrue(resolver.resolveActions(tool(ToolCallStatus.PENDING), null, content).allowedActions().isEmpty());
        assertTrue(resolver.resolveActions(tool(ToolCallStatus.PENDING), ToolCallKind.PLAN, json.createObjectNode()).allowedActions().isEmpty());
        verifyNoInteractions(executions, activity);
    }

    @Test
    void persistedSuspensionDoesNotOpenActionsUntilOldSignalExits() throws Exception {
        JsonNode content = json.readTree("{\"text\":\"计划\"}");
        when(activity.isActive("3")).thenReturn(true);
        assertTrue(resolver.resolveActions(tool(ToolCallStatus.PENDING), ToolCallKind.PLAN, content).allowedActions().isEmpty());
        verifyNoInteractions(executions);

        when(activity.isActive("3")).thenReturn(false);
        Execution suspended = Execution.builder().agentRequest(AgentRequest.builder().build())
                .executionState(ExecutionState.SUSPENDED).build();
        when(executions.findById("3")).thenReturn(Optional.of(suspended));
        assertEquals(List.of("APPROVE", "REJECT"), resolver.resolveActions(tool(ToolCallStatus.PENDING), ToolCallKind.PLAN, content).allowedActions());
        assertEquals(List.of("ANSWER"), resolver.resolveActions(tool(ToolCallStatus.PENDING), ToolCallKind.CHOICE,
                json.readTree("{\"question\":\"选什么？\"}")).allowedActions());
    }

    @Test
    void terminalOrMissingExecutionNeverExposesActions() throws Exception {
        JsonNode content = json.readTree("{\"command\":\"echo hi\"}");
        when(executions.findById("3")).thenReturn(Optional.empty());
        assertTrue(resolver.resolveActions(tool(ToolCallStatus.PENDING), ToolCallKind.COMMAND, content).allowedActions().isEmpty());
        Execution cancelled = Execution.builder().agentRequest(AgentRequest.builder().build())
                .executionState(ExecutionState.CANCELLED).build();
        when(executions.findById("3")).thenReturn(Optional.of(cancelled));
        assertTrue(resolver.resolveActions(tool(ToolCallStatus.PENDING), ToolCallKind.COMMAND, content).allowedActions().isEmpty());
    }

    private ToolCall tool(ToolCallStatus status) {
        return ToolCall.builder().id("call-test").conversationId(2L).executionId(3L)
                .type(ToolCallType.PROMISE).status(status).build();
    }

    private static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}
