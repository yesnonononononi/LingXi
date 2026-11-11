package com.summit.dp.session;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.ContextSpec;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.core.conversation.message.*;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.infrastructure.context.LocalSessionContextFileStore;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.lifecycle.ContextRecoveringFailureObserver;
import com.summit.runtime.conversation.DefaultTokenizer;
import openAi.OpenAiTokenizer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.ArgumentCaptor;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** 上下文正文只落文件、库里只留正文标识：本用例直接盯文件与库引用两侧。 */
class ModelContextServiceTest {
    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final SessionContextRepository repository = mock(SessionContextRepository.class);

    @TempDir
    Path dataDir;

    private final ModelContextService service() {
        return new ModelContextService(repository, new LocalSessionContextFileStore(dataDir.toString(), mapper));
    }

    /** 正文文件路径由「会话目录 + 正文标识」唯一确定，与生产实现同一套布局。 */
    private Path bodyFile(long sessionId, String bodyId) {
        return dataDir.resolve("session-context").resolve(Long.toString(sessionId)).resolve(bodyId + ".jsonl");
    }

    private List<JsonNode> bodyLines(long sessionId, String bodyId) throws IOException {
        List<JsonNode> lines = new ArrayList<>();
        for (String line : Files.readAllLines(bodyFile(sessionId, bodyId))) {
            if (!line.isBlank()) {
                lines.add(mapper.readTree(line));
            }
        }
        return lines;
    }

    @Test
    void storesOneMessagePerLineAndRestoresConcreteMutableMessages() throws Exception {
        ModelContextService service = service();
        when(repository.findSummary(201L)).thenReturn(Optional.empty());
        service.replace(201L, List.of(SystemMessageEntity.builder().text("system").build(),
                UserMessageEntity.from("hello"), AiMessageEntity.builder().text("answer").build(),
                ToolMessageEntity.builder().id("call").toolOutput("result").build()));
        ArgumentCaptor<SessionContext> saved = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).save(saved.capture());
        // 库内只有正文标识，正文落成 JSONL：一条消息一行。
        String bodyId = saved.getValue().getSnapshotFile();
        assertNotNull(bodyId);
        assertTrue(bodyId.matches("[0-9a-f]{32}"), "正文标识必须是不带连字符的十六进制");
        List<JsonNode> lines = bodyLines(201L, bodyId);
        assertEquals(4, lines.size());
        assertTrue(lines.get(0).isObject(), "JSONL 一行一条消息");
        assertTrue(lines.get(1).path("content").isArray(), "用户消息正文按块序列化成数组");

        when(repository.findSummary(201L)).thenReturn(Optional.of(SessionContext.restoreSummary(201L, 1L, bodyId)));
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
        ModelContextService service = service();
        when(repository.findSummary(201L)).thenReturn(Optional.of(SessionContext.restoreSummary(201L, 7L, null)));

        service.replace(201L, List.of(UserMessageEntity.from("新正文")));

        verify(repository, never()).findById(any());
        ArgumentCaptor<SessionContext> updated = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).updateById(updated.capture());
        verify(repository, never()).save(any());
        // 行为保持不变：版本在库里那一版基础上 +1，正文文件是本次写入的新内容。
        assertEquals(8L, updated.getValue().getVersion());
        List<JsonNode> lines = bodyLines(201L, updated.getValue().getSnapshotFile());
        assertEquals(1, lines.size());
        assertEquals("新正文", lines.get(0).path("content").get(0).path("text").asText());
    }

    /** 替换成功后旧正文文件必须被回收，否则每轮都留一份废文件。 */
    @Test
    void replacingDeletesTheSupersededBodyFile() throws IOException {
        ModelContextService service = service();
        when(repository.findSummary(201L)).thenReturn(Optional.empty());
        service.replace(201L, List.of(UserMessageEntity.from("第一版")));
        ArgumentCaptor<SessionContext> saved = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).save(saved.capture());
        String first = saved.getValue().getSnapshotFile();
        assertTrue(Files.exists(bodyFile(201L, first)));

        when(repository.findSummary(201L)).thenReturn(Optional.of(SessionContext.restoreSummary(201L, 1L, first)));
        service.replace(201L, List.of(UserMessageEntity.from("第二版")));
        ArgumentCaptor<SessionContext> updated = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).updateById(updated.capture());
        String second = updated.getValue().getSnapshotFile();
        assertNotEquals(first, second);
        assertFalse(Files.exists(bodyFile(201L, first)), "被替换掉的正文文件必须删除");
        assertTrue(Files.exists(bodyFile(201L, second)));
    }

    @Test
    void replacesExistingContextAndHandlesEmptyHistory() {
        ModelContextService service = service();
        when(repository.findSummary(201L)).thenReturn(Optional.of(SessionContext.restoreSummary(201L, 1L, null)));
        service.replace(201L, List.of());
        ArgumentCaptor<SessionContext> updated = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).updateById(updated.capture());
        assertEquals(2L, updated.getValue().getVersion());
        when(repository.findSummary(201L))
                .thenReturn(Optional.of(SessionContext.restoreSummary(201L, 2L, updated.getValue().getSnapshotFile())));
        assertTrue(service.find(201L).orElseThrow().isEmpty());
    }

    /** 行不存在 → 空；行在但正文标识为空（历史行未迁移）→ 空；标识指向的文件缺失 → 必须炸，不能冒充空历史。 */
    @Test
    void absentOrUnmigratedContextIsEmptyButMissingFileFails() {
        ModelContextService service = service();
        when(repository.findSummary(201L)).thenReturn(Optional.empty());
        assertTrue(service.find(201L).isEmpty());

        when(repository.findSummary(201L)).thenReturn(Optional.of(SessionContext.restoreSummary(201L, 1L, null)));
        assertTrue(service.find(201L).isEmpty());

        when(repository.findSummary(201L))
                .thenReturn(Optional.of(SessionContext.restoreSummary(201L, 1L, "0".repeat(32))));
        assertThrows(IllegalStateException.class, () -> service.find(201L));
    }

    @Test
    void failedParallelToolArgumentsSurviveRecoveryAndAllowTheNextContextBudgetCheck() throws Exception {
        ModelContextService service = service();
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
                .contextSpec(ContextSpec.builder().context(originalRound).build())
                .build(), "qa");
        // 旧 TokenEstimatorAdapter 会先把消息重新序列化成 JSON 再解析，坏的工具参数直接在这里炸开（线上事故现场）。
        // 框架新实现 openAi.OpenAiTokenizer 只做本地 BPE 计数、不解析参数 JSON，因此分两步守住同一条契约：
        //   1) 事故里的坏参数仍然是非法 JSON（现场可复现）；
        //   2) 新口径下同一批消息的估算不再被坏参数阻断 —— 这正是迁移后必须保住的行为。
        com.fasterxml.jackson.core.JsonParseException parseFailure =
                assertThrows(com.fasterxml.jackson.core.JsonParseException.class, () -> mapper.readTree(brokenArguments),
                        "QA 事故里的并发工具参数必须仍是非法 JSON");
        assertEquals(1, parseFailure.getLocation().getLineNr());
        assertEquals(398, parseFailure.getLocation().getColumnNr());
        RuntimeException originalFailure = new IllegalStateException("工具参数不是合法 JSON", parseFailure);
        OpenAiTokenizer estimator = new OpenAiTokenizer();
        assertDoesNotThrow(() -> estimator.estimateMessages(execution.getMessages()),
                "坏的工具参数不得阻断 token 估算（旧适配器在这里抛 JsonParseException）");
        DefaultTokenizer tokenizer = new DefaultTokenizer(estimator);
        int originalCount = assertDoesNotThrow(() -> tokenizer.count(execution.getMessages()));
        when(repository.findSummary(201L)).thenReturn(Optional.empty());

        new ContextRecoveringFailureObserver(service).onFailure(execution, originalFailure);
        ArgumentCaptor<SessionContext> saved = ArgumentCaptor.forClass(SessionContext.class);
        verify(repository).save(saved.capture());
        when(repository.findSummary(201L))
                .thenReturn(Optional.of(SessionContext.restoreSummary(201L, 1L, saved.getValue().getSnapshotFile())));
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

