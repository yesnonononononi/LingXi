package com.summit.dp.session;

import com.fasterxml.jackson.core.JsonParseException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import openAi.OpenAiTokenizer;
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
        when(repository.findSummary(201L)).thenReturn(Optional.empty());
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

    /**
     * 门槛守卫：替换正文路径只走摘要查询，绝不把旧正文读进堆。
     *
     * <p>旧实现为了判「行存不存在」整段读 {@code findById}；这条断言就是那次的翻红点 ——
     * 谁把摘要查询改回整段加载，这里立刻红。</p>
     */
    @Test
    void replacingContentNeverLoadsTheOldContent() throws Exception {
        when(repository.findSummary(201L)).thenReturn(Optional.of(SessionContext.restoreSummary(201L, 7L)));

        service.replace(201L, List.of(UserMessageEntity.from("新正文")));

        verify(repository, never()).findById(any());
        ArgumentCaptor<SessionContext> updated = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).updateById(updated.capture());
        verify(repository, never()).save(any());
        // 行为保持不变：版本在库里那一版基础上 +1，正文是本次写入的新内容。
        assertEquals(8L, updated.getValue().getVersion());
        assertEquals("新正文", mapper.readTree(updated.getValue().getContent()).get(0)
                .path("content").get(0).path("text").asText());
    }

    @Test
    void replacesExistingContextAndHandlesEmptyHistory() {
        when(repository.findSummary(201L)).thenReturn(Optional.of(SessionContext.restoreSummary(201L, 1L)));
        service.replace(201L, List.of());
        ArgumentCaptor<SessionContext> updated = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).updateById(updated.capture());
        assertEquals(2L, updated.getValue().getVersion());
        when(repository.findById(201L)).thenReturn(Optional.of(updated.getValue()));
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
        RuntimeException originalFailure;
        JsonParseException parseFailure;
        // 旧 TokenEstimatorAdapter 会先把消息重新序列化成 JSON 再解析，坏的工具参数直接在这里炸开（线上事故现场）。
        // 框架新实现 openAi.OpenAiTokenizer 只做本地 BPE 计数、不解析参数 JSON，因此分两步守住同一条契约：
        //   1) 事故里的坏参数仍然是非法 JSON（现场可复现）；
        //   2) 新口径下同一批消息的估算不再被坏参数阻断 —— 这正是迁移后必须保住的行为。
        parseFailure = assertThrows(JsonParseException.class, () -> mapper.readTree(brokenArguments),
                "QA 事故里的并发工具参数必须仍是非法 JSON");
        // 旧实现是在「整段消息重新序列化」时炸在第 398 列；这里直接解析坏参数，命中的仍是同一处缺陷（实测同为第 1 行第 398 列）。
        assertEquals(1, parseFailure.getLocation().getLineNr());
        assertEquals(398, parseFailure.getLocation().getColumnNr());
        originalFailure = new IllegalStateException("工具参数不是合法 JSON", parseFailure);
        OpenAiTokenizer estimator = new OpenAiTokenizer();
        assertDoesNotThrow(() -> estimator.estimateMessages(execution.getMessages()),
                "坏的工具参数不得阻断 token 估算（旧适配器在这里抛 JsonParseException）");
        DefaultTokenizer tokenizer = new DefaultTokenizer(estimator);
        int originalCount = assertDoesNotThrow(() -> tokenizer.count(execution.getMessages()));
        when(repository.findSummary(201L)).thenReturn(Optional.empty());

        new ContextRecoveringFailureObserver(service).onFailure(execution, originalFailure);
        ArgumentCaptor<SessionContext> saved = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).save(saved.capture());
        when(repository.findById(201L)).thenReturn(Optional.of(saved.getValue()));
        List<Message> restored = service.find(201L).orElseThrow();
        restored.add(UserMessageEntity.from("继续重试"));

        // 框架升级：usage 新增「工具定义」参数（工具定义也占上下文），此处无工具定义故传空列表，
        // 与升级前 usage(messages, maxTokens) 的语义等价。
        ContextUsageMetric usage = assertDoesNotThrow(
                () -> tokenizer.usage(restored, List.of(), 258000));
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
