package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.core.JsonParseException;
import com.summit.adapter.langchain4j.codec.token.TokenEstimatorAdapter;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.core.conversation.message.*;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.lifecycle.ContextRecoveringFailureObserver;
import com.summit.runtime.conversation.DefaultTokenizer;
import dev.langchain4j.model.openai.OpenAiTokenCountEstimator;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ModelContextServiceTest {
    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final SessionContextRepository repository = mock(SessionContextRepository.class);
    private final ModelContextService service = new ModelContextService(mapper, repository);

    @Test
    void storesPlainMessageArrayAndRestoresConcreteMutableMessages() throws Exception {
        when(repository.findById(201L)).thenReturn(Optional.empty());
        service.replace(201L, List.of(SystemMessageEntity.builder().text("system").build(),
                UserMessageEntity.from("hello"), AiMessageEntity.builder().text("answer").build(),
                ToolMessageEntity.builder().id("call").toolOutput("result").build()));
        ArgumentCaptor<SessionContext> saved = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).save(saved.capture());
        assertTrue(mapper.readTree(saved.getValue().getContent()).isArray());
        assertTrue(mapper.readTree(saved.getValue().getContent()).get(1).path("content").isArray());
        when(repository.findById(201L)).thenReturn(Optional.of(saved.getValue()));
        List<Message> restored = service.find(201L).orElseThrow();
        assertInstanceOf(SystemMessageEntity.class, restored.get(0));
        assertInstanceOf(UserMessageEntity.class, restored.get(1));
        assertInstanceOf(AiMessageEntity.class, restored.get(2));
        assertInstanceOf(ToolMessageEntity.class, restored.get(3));
        assertEquals("hello", restored.get(1).text());
        assertDoesNotThrow(() -> restored.add(UserMessageEntity.from("next")));
    }

    @Test
    void replacesExistingContextAndHandlesEmptyHistory() {
        SessionContext existing = SessionContext.create(201L);
        existing.changeContent("[]");
        when(repository.findById(201L)).thenReturn(Optional.of(existing));
        service.replace(201L, List.of());
        verify(repository).updateById(existing);
        assertEquals(2L, existing.getVersion());
        assertTrue(service.find(201L).orElseThrow().isEmpty());
    }

    @Test
    void absentContextStaysAbsentAndLegacyEncodingIsRejected() {
        when(repository.findById(201L)).thenReturn(Optional.empty());
        assertTrue(service.find(201L).isEmpty());
        SessionContext old = SessionContext.create(201L);
        old.changeContent("[{\"type\":\"USER\",\"content\":\"{\\\"type\\\":\\\"USER\\\",\\\"content\\\":[]}\"}]");
        when(repository.findById(201L)).thenReturn(Optional.of(old));
        assertThrows(IllegalStateException.class, () -> service.find(201L));
    }

    @Test
    void failedParallelToolArgumentsSurviveRecoveryAndAllowTheNextContextBudgetCheck() throws Exception {
        AiMessageEntity assistant;
        JsonNode fixture;
        try (InputStream input = getClass().getResourceAsStream("/session/qa-2115831010687148032.json")) {
            assertNotNull(input);
            fixture = mapper.readTree(input);
            assistant = mapper.treeToValue(fixture.get("assistant"), AiMessageEntity.class);
        }
        assertEquals("call_01_ijonbf4n2xk6klx5vyckq1pd", assistant.getToolCalls().get(1).id());
        String brokenArguments = assistant.getToolCalls().get(1).arguments();
        List<Message> originalRound = new ArrayList<>(List.of(assistant));
        for (JsonNode result : fixture.get("toolResults")) {
            originalRound.add(ToolMessageEntity.builder().id(result.get("id").asText())
                    .name(result.get("name").asText()).toolOutput(result.get("output").asText())
                    .isError("FAILED".equals(result.get("outcome").asText())).build());
        }
        Execution execution = Execution.create(AgentRequest.builder().executionId("301")
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, 201L)).build())
                .messages(originalRound)
                .build(), "qa");
        RuntimeException originalFailure = assertThrows(RuntimeException.class,
                () -> new TokenEstimatorAdapter(new OpenAiTokenCountEstimator("gpt-3.5-turbo"))
                        .estimateMessages(execution.getMessages()));
        Throwable originalCause = originalFailure;
        while (originalCause.getCause() != null) {
            originalCause = originalCause.getCause();
        }
        JsonParseException parseFailure = assertInstanceOf(JsonParseException.class, originalCause);
        assertEquals(1, parseFailure.getLocation().getLineNr());
        assertEquals(398, parseFailure.getLocation().getColumnNr());
        DefaultTokenizer tokenizer = new DefaultTokenizer(new TokenEstimatorAdapter("gpt-3.5-turbo"));
        int originalCount = assertDoesNotThrow(() -> tokenizer.count(execution.getMessages()));
        when(repository.findById(201L)).thenReturn(Optional.empty());

        new ContextRecoveringFailureObserver(service).onFailure(execution, originalFailure);
        ArgumentCaptor<SessionContext> saved = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).save(saved.capture());
        when(repository.findById(201L)).thenReturn(Optional.of(saved.getValue()));
        List<Message> restored = service.find(201L).orElseThrow();
        restored.add(UserMessageEntity.from("继续重试"));

        ContextUsageMetric usage = assertDoesNotThrow(() -> tokenizer.usage(restored, 258000));
        assertNotNull(usage);
        int recoveredCount = tokenizer.count(restored);
        assertTrue(recoveredCount > originalCount);
        AiMessageEntity restoredAssistant = assertInstanceOf(AiMessageEntity.class, restored.get(0));
        assertEquals(brokenArguments, restoredAssistant.getToolCalls().get(1).arguments());
        assertTrue(assertInstanceOf(ToolMessageEntity.class, restored.get(2)).isError());
        assertInstanceOf(SystemMessageEntity.class, restored.get(3));
        System.out.printf("QA 原始错误回放: errorColumn=%d, argumentCharacters=%d, originalTokens=%d, recoveredTokens=%d%n",
                parseFailure.getLocation().getColumnNr(), brokenArguments.length(), originalCount, recoveredCount);
    }
}
