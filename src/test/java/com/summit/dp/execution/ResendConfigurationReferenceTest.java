package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.ResendTargetResolver;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ResendConfigurationReferenceTest {
    @Test
    void legacyCredentialsDoNotPreventReadingTheResendBaseline() throws Exception {
        ObjectMapper mapper = new JsonConfig().objectMapper();
        ObjectNode snapshot = mapper.createObjectNode().put("id", "100");
        snapshot.putObject("agentRequest").putObject("modelConfig").put("apiKey", "retired-key-canary");
        List<Message> history = List.of(SystemMessageEntity.builder().text("压缩后的历史").build(), UserMessageEntity.from("目标提问"));
        snapshot.set("messages", mapper.valueToTree(history));
        String json = mapper.writeValueAsString(snapshot);
        assertThrows(UnrecognizedPropertyException.class, () -> mapper.readValue(json, Execution.class));
        SessionMessageQueryService messages = mock(SessionMessageQueryService.class);
        ChatTurnService turns = mock(ChatTurnService.class);
        ExecutionQueryService executions = mock(ExecutionQueryService.class);
        when(messages.findByMessageId(30L)).thenReturn(Result.success(SessionMessageVO.builder()
                .id(30L).turnId(20L).sessionId(10L).type("USER").build()));
        when(turns.findByIds(List.of(20L))).thenReturn(Map.of(20L,
                ChatTurn.builder().id(20L).sessionId(10L).executionId(100L).build()));
        when(executions.findSnapshotById(100L)).thenReturn(json);
        ResendTargetResolver resolver = new ResendTargetResolver(messages, turns, executions, mapper);
        ResendTargetResolver.ResendTarget target = resolver.resolve(new ChatCommand("修改提问", 10L, null,
                null, 30L, null, false, List.of(), List.of()));
        assertEquals(1, target.baseline().size());
        assertEquals("压缩后的历史", target.baseline().getFirst().text());
    }
}
