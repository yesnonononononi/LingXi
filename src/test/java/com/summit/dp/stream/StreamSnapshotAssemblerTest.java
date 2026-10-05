package com.summit.dp.stream;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.session.domain.repo.*;
import com.summit.dp.session.domain.model.*;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.turn.domain.model.*;
import com.summit.dp.stream.application.service.*;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.any;

class StreamSnapshotAssemblerTest {
    @Test void scopeRetainsAllActiveTurnsAndOldUnresolvedCardsButExcludesSystemAndCheckpointContent() {
        SessionRepository sessions = mock(SessionRepository.class);
        MessageRepository messages = mock(MessageRepository.class);
        ToolCallRepository tools = mock(ToolCallRepository.class);
        ChatTurnRepository turns = mock(ChatTurnRepository.class);
        ExecutionRepository executions = mock(ExecutionRepository.class);
        StreamClientViewAssembler views = mock(StreamClientViewAssembler.class);
        PlatformTransactionManager manager = mock(PlatformTransactionManager.class);
        when(manager.getTransaction(any())).thenReturn(new SimpleTransactionStatus());
        Session root = Session.builder().id(1L).rootSessionId(0L).build();
        when(sessions.findById(1L)).thenReturn(Optional.of(root)); when(sessions.findSessionTree(1L)).thenReturn(List.of(root));
        Execution activeExecution = mock(Execution.class); when(activeExecution.getId()).thenReturn(102L);
        when(executions.findUnfinishedBySessions(List.of(1L))).thenReturn(List.of(activeExecution));
        List<ChatTurn> history = new ArrayList<>();
        history.add(ChatTurn.builder().id(1L).sessionId(1L).executionId(101L).status(ChatTurnStatus.WAITING).build());
        for (long id = 2; id <= 45; id++) history.add(ChatTurn.builder().id(id).sessionId(1L).executionId(100L + id)
                .status(ChatTurnStatus.COMPLETED).build());
        when(turns.findFromId(1L, 0L)).thenReturn(history);
        ToolCall oldPending = mock(ToolCall.class);
        when(oldPending.isUnresolved()).thenReturn(true); when(oldPending.getExecutionId()).thenReturn(102L);
        when(tools.listByConversationId(1L)).thenReturn(List.of(oldPending));
        SessionMessage system = SessionMessage.builder().id(90L).sessionId(1L).turnId(1L).type(SessionMessageType.SYSTEM).text("系统提示").build();
        SessionMessage active = SessionMessage.builder().id(91L).sessionId(1L).turnId(1L).type(SessionMessageType.AI).text("等待中的回答").build();
        when(messages.findBySessionId(1L)).thenReturn(List.of(system, active));
        ObjectMapper json = new ObjectMapper();
        when(views.session(root)).thenReturn(json.createObjectNode().put("id", "1"));
        when(views.turn(any())).thenAnswer(call -> json.createObjectNode().put("turnId", String.valueOf(((ChatTurn) call.getArgument(0)).getId())));
        when(views.tool(oldPending)).thenReturn(json.createObjectNode().put("id", "旧待办"));
        when(views.message(active)).thenReturn(json.createObjectNode().put("text", "等待中的回答"));
        StreamSnapshotAssembler assembler = new StreamSnapshotAssembler(sessions, tools, views,
                new TurnRetainResolver(turns, executions),
                new MessageRetainResolver(messages),
                new TransactionTemplate(manager), executions);
        StreamSnapshotAssembler.Base base = assembler.load(1);
        assertEquals(34, base.turns().size());
        assertTrue(base.turns().stream().anyMatch(turn -> turn.path("turnId").asText().equals("1")));
        assertTrue(base.turns().stream().anyMatch(turn -> turn.path("turnId").asText().equals("2")));
        assertEquals(1, base.tools().size()); assertEquals(1, base.messages().size());
        verify(executions).findSummariesByIds(argThat(ids -> ids.contains(102L) && ids.contains(101L)));
        verify(views, never()).message(system);
    }
}
