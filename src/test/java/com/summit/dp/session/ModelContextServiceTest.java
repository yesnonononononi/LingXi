package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.adapter.langchain4j.codec.token.TokenEstimatorAdapter;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.core.conversation.api.ToolCallRequest;
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
    void failedParallelToolArgumentsSurviveRecoveryAndAllowTheNextContextBudgetCheck() {
        String brokenArguments = "{\"command\":\"git status\", \"intent: \"查看提交\"}";
        AiMessageEntity assistant = AiMessageEntity.builder().text("检查最近提交")
                .toolCalls(List.of(ToolCallRequest.builder().id("read").name("read_file")
                                .arguments("{\"path\":\"README.md\"}").build(),
                        ToolCallRequest.builder().id("command").name("execute_command")
                                .arguments(brokenArguments).build()))
                .build();
        Execution execution = Execution.create(AgentRequest.builder().executionId("301")
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, 201L)).build())
                .messages(List.of(UserMessageEntity.from("检查最近提交"), assistant,
                        ToolMessageEntity.builder().id("read").name("read_file").toolOutput("文件内容").build(),
                        ToolMessageEntity.builder().id("command").name("execute_command")
                                .toolOutput("工具参数不是合法 JSON").isError(true).build()))
                .build(), "qa");
        RuntimeException originalFailure = assertThrows(RuntimeException.class,
                () -> new TokenEstimatorAdapter(new OpenAiTokenCountEstimator("gpt-3.5-turbo"))
                        .estimateMessages(execution.getMessages()));
        when(repository.findById(201L)).thenReturn(Optional.empty());

        new ContextRecoveringFailureObserver(service).onFailure(execution, originalFailure);
        ArgumentCaptor<SessionContext> saved = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).save(saved.capture());
        when(repository.findById(201L)).thenReturn(Optional.of(saved.getValue()));
        List<Message> restored = service.find(201L).orElseThrow();
        restored.add(UserMessageEntity.from("继续重试"));

        DefaultTokenizer tokenizer = new DefaultTokenizer(new TokenEstimatorAdapter("gpt-3.5-turbo"));
        ContextUsageMetric usage = assertDoesNotThrow(() -> tokenizer.usage(restored, 258000));
        assertNotNull(usage);
        assertTrue(tokenizer.count(restored) > 0);
        AiMessageEntity restoredAssistant = assertInstanceOf(AiMessageEntity.class, restored.get(1));
        assertEquals(brokenArguments, restoredAssistant.getToolCalls().get(1).arguments());
        assertTrue(assertInstanceOf(ToolMessageEntity.class, restored.get(3)).isError());
        assertInstanceOf(SystemMessageEntity.class, restored.get(4));
    }
}
