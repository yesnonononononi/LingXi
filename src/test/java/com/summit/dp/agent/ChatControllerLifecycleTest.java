package com.summit.dp.agent;

import com.baomidou.mybatisplus.core.toolkit.Wrappers;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import mcp.McpSessionFactory;
import com.summit.core.agent.Execution;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.ModelRetryConfig;
import com.summit.core.conversation.api.ChatRequestEntity;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.RequestModelInvokerFactory;
import com.summit.core.model.streaming.StreamingChatModel;
import com.summit.core.runtime.loop.suspension.ExecutionInterruptedException;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.dp.workflow.application.chat.AgentWorkflowOrchestrator;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import com.summit.runtime.model.DefaultChatModelInvoker;
import com.summit.runtime.model.DefaultStreamingModelInvoker;
import com.sun.net.httpserver.HttpServer;
import openAi.DefaultChatModel;
import openAi.MessageSerializer;
import openAi.ModelChatResolver;
import openAi.RequestBodyFactory;
import openAi.ResponseSerializer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;

import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 模型由闸门控制，入口、检查点、消息与轮次走实际实现和 H2。 */
@SpringBootTest(properties = {
        "lingxi.data.dir=D:/Code/LingXi/.run/chat-controls/data", "lingxi.skill.dir=",
        "lingxi.config.sandbox-security.directory=.run/chat-controls/security",
        "lingxi.config.user-configs.path=D:/Code/LingXi/.run/chat-controls/user-configs.json",
        "lingxi.config.mcp.path=D:/Code/LingXi/.run/chat-controls/mcp.json",
        "lingxi.config.model.path=D:/Code/LingXi/.run/chat-controls/models.json",
        "lingxi.config.personalization.path=D:/Code/LingXi/.run/chat-controls/personalization.json",
        "TAVILY_APIKEY=test-placeholder", "DEEPSEEK_APIKEY=test-placeholder"
})
@AutoConfigureMockMvc
class ChatControllerLifecycleTest {
    /** 库建在系统临时目录：用例之间互不干扰，也不在工作区留 *.sqlite/-wal。 */
    private static final String DATABASE_URL = H2TestDatabase.newDatasourceUrl("chat-controls");

    @org.springframework.test.context.DynamicPropertySource
    static void datasource(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", () -> DATABASE_URL);
        registry.add("spring.datasource.driver-class-name", () -> "org.h2.Driver");
    }

    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper mapper;
    @Autowired private SessionService sessions;
    @Autowired private ExecutionMapper executions;
    @Autowired private MessageRepository messages;
    @Autowired private ChatTurnRepository turns;
    @MockitoBean private McpSessionFactory mcp;
    @MockitoBean private RequestModelInvokerFactory modelFactory;
    @MockitoBean private ModelService models;
    @MockitoBean private SettingsProvider settings;
    @MockitoSpyBean private AgentWorkflowOrchestrator orchestrator;
    @MockitoSpyBean private PreparedChatExecutor executor;
    @MockitoSpyBean private LocalExecutionRepository checkpoints;
    @MockitoSpyBean private SseEventPublisher eventPublisher;

    private final BlockingQueue<Gate> gates = new LinkedBlockingQueue<>();
    private final List<List<Message>> requestsSeen = new CopyOnWriteArrayList<>();
    private final AtomicInteger modelCalls = new AtomicInteger();
    private final Set<String> finishedRuns = ConcurrentHashMap.newKeySet();

    @Test
    void streamingRetryPersistsOnlyTheRecoveredResponseAndPublishesAuthoritativeTurnViews() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        CountDownLatch retrySeen = new CountDownLatch(1);
        List<JsonNode> frames = new CopyOnWriteArrayList<>();
        doAnswer(invocation -> {
            Execution execution = invocation.getArgument(0);
            execution.getAgentRequest().setRetryConfig(ModelRetryConfig.builder().enabled(true).maxRetries(2)
                    .initialDelay(Duration.ZERO).maxDelay(Duration.ZERO).build());
            return invocation.callRealMethod();
        }).when(checkpoints).save(any());
        doAnswer(invocation -> {
            AgentEvent event = invocation.getArgument(1);
            frames.add(mapper.valueToTree(event));
            return invocation.callRealMethod();
        }).when(eventPublisher).publish(anyLong(), any(AgentEvent.class));
        doAnswer(invocation -> {
            String name = invocation.getArgument(1);
            Object payload = invocation.getArgument(2);
            ObjectNode frame = mapper.valueToTree(payload);
            frame.put("type", name);
            frames.add(frame);
            if ("INVOKE_RETRY".equals(name)) retrySeen.countDown();
            return invocation.callRealMethod();
        }).when(eventPublisher).publishBusiness(anyLong(), anyString(), any());
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        try (ExecutorService workers = Executors.newCachedThreadPool()) {
            server.setExecutor(workers);
            server.createContext("/", exchange -> StreamingRetryContractTest.respond(exchange, "OPENAI_SSE", false,
                    requests.incrementAndGet(), retrySeen));
            server.start();
            // 模型侧改用框架自有实现：LangChain4j 适配器（StreamingChatModelAdapter）已退役。
            // 其余断言（请求次数、终态、token、事件）沿用原样，这段只换模型构造。
            StreamingChatModel model = new DefaultChatModel(ModelConfig.builder()
                    .provider(DefaultModelProviderNames.DEFAULT_STREAMING)
                    .baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1")
                    .apiKey("test").modelName("controlled-model").timeout(Duration.ofSeconds(3)).build(),
                    new ModelChatResolver(new RequestBodyFactory(new MessageSerializer(mapper), mapper), mapper,
                            new ResponseSerializer()),
                    HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build());
            when(modelFactory.select(any(ModelConfig.class))).thenReturn(new RequestModelInvokerFactory.Selection(
                    "default-streaming", new DefaultStreamingModelInvoker(model), true));
            Long sessionId = sessions.initialize("流式重试闭环验证", null, null).getData();
            Long turnId = Long.valueOf(accept(sessionId, "遇到短暂故障后继续").path("turnId").asText());
            waitForState(sessionId, 3);
            assertEquals(2, requests.get());
            ChatTurn turn = turns.findById(turnId).orElseThrow();
            assertEquals("COMPLETED", turn.getStatus().name());
            assertEquals(5L, turn.getTotalTokenCount());
            List<SessionMessage> replies = messages.findByTurnIds(sessionId, List.of(turnId)).stream()
                    .filter(message -> message.getType() == SessionMessageType.AI).toList();
            assertEquals(1, replies.size());
            assertTrue(replies.getFirst().getText().contains("recovered"));
            assertFalse(replies.getFirst().getText().contains("discard"));
            assertEquals(1, frames.stream().filter(frame -> frame.path("type").asText().equals("INVOKE_RETRY")).count());
            assertEquals(0, frames.stream().filter(frame -> frame.path("type").asText().equals("EXECUTION_FAILED")).count());
            JsonNode view = mapper.readTree(mvc.perform(get("/session/{id}/messages", sessionId))
                    .andExpect(status().isOk()).andReturn().getResponse().getContentAsString())
                    .path("data").path("turnViews").path(turnId.toString());
            assertEquals("COMPLETED", view.path("status").asText());
            assertTrue(view.path("blocks").get(0).path("isBody").asBoolean());
            String export = System.getProperty("lingxi.retry.spring.output");
            if (export != null) mapper.writeValue(Path.of(export).toFile(), frames);
        } finally {
            server.stop(0);
        }
    }

    private static final class Gate {
        private final CountDownLatch entered = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final ChatResponseEntity response;
        Gate(ChatResponseEntity response) { this.response = response; }
    }

    @BeforeEach
    void configureModel() {
        doAnswer(invocation -> {
            RuntimeContext context = invocation.getArgument(0);
            try { return invocation.callRealMethod(); }
            finally { finishedRuns.add(context.executionContext().executionId()); }
        }).when(executor).run(any());
        SettingsView view = new SettingsView(null, null, null, null, 7L, null, 64000, "low", null, 10);
        when(settings.current()).thenReturn(Optional.of(view));
        when(models.resolveRuntimeConfig(any(), any())).thenReturn(new RuntimeModel(ModelConfig.builder().modelName("controlled-model")
                .baseUrl("https://example.invalid").apiKey("controlled-key").provider("default").build(), false));
        when(modelFactory.select(any(ModelConfig.class))).thenReturn(new RequestModelInvokerFactory.Selection(
                "default", new DefaultChatModelInvoker(this::invoke), false));
    }

    private ChatResponseEntity invoke(ChatRequestEntity request) {
        requestsSeen.add(List.copyOf(request.getMessages()));
        modelCalls.incrementAndGet();
        Gate gate = gates.poll();
        if (gate == null) return reply("实际循环完成");
        gate.entered.countDown();
        try {
            if (!gate.release.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("测试模型闸门超时");
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new ExecutionInterruptedException(ExecutionInterruptedException.Kind.CANCEL, "测试模型等待已中断");
        }
        return gate.response;
    }

    @Test
    void pendingCommandsBecomeOrderedTurnsWithThePreviousAnswerInContext() throws Exception {
        Long sessionId = sessions.initialize("待发送队列验证", null, null).getData();
        Gate first = new Gate(reply("第一轮的模型回答"));
        Gate second = new Gate(reply("第二轮的模型回答"));
        Gate third = new Gate(reply("第三轮的模型回答"));
        gates.addAll(List.of(first, second, third));
        try {
            long firstTurn = Long.parseLong(accept(sessionId, "第一轮输入").path("turnId").asText());
            assertTrue(first.entered.await(5, TimeUnit.SECONDS));
            JsonNode secondReceipt = accept(sessionId, "第二轮输入");
            JsonNode thirdReceipt = accept(sessionId, "第三轮输入");
            JsonNode cancelledReceipt = accept(sessionId, "撤销这条输入");
            assertTrue(secondReceipt.path("pendingId").isTextual());
            assertTrue(secondReceipt.path("turnId").isNull() || secondReceipt.path("turnId").isMissingNode());
            assertEquals(1, turns.findLatest(sessionId, null, 10).size());
            mvc.perform(delete("/a/completion/{id}/pending/{pendingId}", sessionId, cancelledReceipt.path("pendingId").asText()))
                    .andExpect(jsonPath("$.code").value(1));
            mvc.perform(get("/a/completion/{id}/pending", sessionId))
                    .andExpect(jsonPath("$.data.entries[0].id").value(secondReceipt.path("pendingId").asText()))
                    .andExpect(jsonPath("$.data.entries[1].id").value(thirdReceipt.path("pendingId").asText()))
                    .andExpect(jsonPath("$.data.entries.length()").value(2));

            first.release.countDown();
            assertTrue(second.entered.await(7, TimeUnit.SECONDS));
            assertEquals("COMPLETED", turns.findById(firstTurn).orElseThrow().getStatus().name());
            assertEquals(2, turns.findLatest(sessionId, null, 10).size());
            List<Message> secondRequest = requestsSeen.get(1);
            assertEquals("第二轮输入", latestUserInput(secondRequest));
            assertTrue(secondRequest.stream().anyMatch(message -> message instanceof AiMessageEntity answer
                    && "第一轮的模型回答".equals(answer.getText())));

            second.release.countDown();
            assertTrue(third.entered.await(7, TimeUnit.SECONDS));
            assertEquals("第三轮输入", latestUserInput(requestsSeen.get(2)));
            third.release.countDown();
            waitForState(sessionId, 3);
            assertEquals(3, turns.findLatest(sessionId, null, 10).size());
            mvc.perform(get("/a/completion/{id}/pending", sessionId))
                    .andExpect(jsonPath("$.data.entries.length()").value(0));
        } finally {
            first.release.countDown();
            second.release.countDown();
            third.release.countDown();
        }
    }

    private static String latestUserInput(List<Message> request) {
        return request.reversed().stream().filter(UserMessageEntity.class::isInstance)
                .findFirst().map(Message::text).orElseThrow();
    }

    @Test
    void suspendResumeAndRepeatedSuspendUseTheSameExecutionAndTurn() throws Exception {
        Long sessionId = sessions.initialize("暂停恢复验证", null, null).getData();
        Gate first = new Gate(reply("应被暂停丢弃的响应"));
        gates.add(first);
        JsonNode acceptance = accept(sessionId, "开始执行");
        assertTrue(first.entered.await(5, TimeUnit.SECONDS));
        try {
            mvc.perform(post("/a/completion/{id}/suspend", sessionId)).andExpect(status().isOk());
        } finally {
            first.release.countDown();
        }
        waitForState(sessionId, 2);
        Long executionId = latest(sessionId).getId();
        Long turnId = Long.valueOf(acceptance.path("turnId").asText());
        assertEquals("WAITING", turns.findById(turnId).orElseThrow().getStatus().name());
        mvc.perform(post("/a/completion/{id}/suspend", sessionId)).andExpect(status().isOk());
        mvc.perform(post("/a/completion/{id}/resume", sessionId))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(1));
        waitForState(sessionId, 3);
        assertEquals(executionId, latest(sessionId).getId());
        assertEquals("COMPLETED", turns.findById(turnId).orElseThrow().getStatus().name());
        assertEquals(1L, messages.findByTurnIds(sessionId, List.of(turnId)).stream()
                .filter(message -> message.getType() == SessionMessageType.USER).count());
        assertEquals(2, modelCalls.get());
    }

    @Test
    void unresolvedChoiceBlocksManualResume() throws Exception {
        Long sessionId = sessions.initialize("审批恢复验证", null, null).getData();
        ChatResponseEntity choice = reply("");
        choice.setTokenUsage(new TokenUsageEntity(150, new TokenUsageEntity.InputTokens(100, 70),
                new TokenUsageEntity.OutputTokens(50, 20)));
        choice.getAiMessageEntity().setToolCalls(List.of(new ToolCallRequest("choice-control", ToolCatalog.REQUIRE_CHOICE, 0,
                "{\"question\":\"是否继续\",\"options\":[\"继续\",\"停止\"]}")));
        Gate gate = new Gate(choice);
        gate.release.countDown();
        gates.add(gate);
        Long turnId = Long.valueOf(accept(sessionId, "需要选择").path("turnId").asText());
        waitForState(sessionId, 2);
        mvc.perform(post("/a/completion/{id}/resume", sessionId))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.errMsg").value("请先处理待审批事项"));
        assertEquals(1, modelCalls.get());
        mvc.perform(post("/a/completion/{id}/stop", sessionId)).andExpect(status().isOk());
        waitForState(sessionId, 5);
        ChatTurn cancelled = turns.findById(turnId).orElseThrow();
        assertEquals("CANCELLED", cancelled.getStatus().name());
        assertEquals(100L, cancelled.getInputTokenCount());
        assertEquals(50L, cancelled.getOutputTokenCount());
        assertEquals(150L, cancelled.getTotalTokenCount());
        assertEquals(70L, cancelled.getCacheTokens());
        assertEquals(20L, cancelled.getReasoningTokens());
        mvc.perform(post("/a/completion/{id}/stop", sessionId)).andExpect(status().isOk());
        assertEquals(150L, turns.findById(turnId).orElseThrow().getTotalTokenCount());
    }

    @Test
    void resendReplacesTargetAndFollowingTurnsWithoutDuplicatingHistory() throws Exception {
        Long sessionId = sessions.initialize("历史重发验证", null, null).getData();
        Long firstTurn = Long.valueOf(accept(sessionId, "旧问题一").path("turnId").asText());
        waitForState(sessionId, 3);
        Long secondTurn = Long.valueOf(accept(sessionId, "旧问题二").path("turnId").asText());
        waitForState(sessionId, 3);
        SessionMessage firstUser = messages.findByTurnIds(sessionId, List.of(firstTurn)).stream()
                .filter(message -> message.getType() == SessionMessageType.USER).findFirst().orElseThrow();
        JsonNode receipt = mapper.readTree(mvc.perform(multipart("/a/completion/resend")
                        .param("sessionId", sessionId.toString()).param("messageId", firstUser.getId().toString())
                        .param("input", "改写后的问题").param("modelId", "7"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(1))
                .andReturn().getResponse().getContentAsString()).path("data");
        waitForState(sessionId, 3);
        Long newTurn = Long.valueOf(receipt.path("turnId").asText());
        assertNotEquals(firstTurn, newTurn);
        assertTrue(receipt.path("invalidatedTurnIds").toString().contains(firstTurn.toString()));
        assertTrue(receipt.path("invalidatedTurnIds").toString().contains(secondTurn.toString()));
        assertTrue(receipt.path("historyRevision").isTextual());
        assertTrue(turns.findById(firstTurn).isEmpty());
        assertTrue(turns.findById(secondTurn).isEmpty());
        assertTrue(messages.findById(firstUser.getId()).isEmpty());
        assertEquals(1L, messages.findBySessionId(sessionId).stream()
                .filter(message -> message.getType() == SessionMessageType.USER).count());
        Long newUserMessageId = messages.findByTurnIds(sessionId, List.of(newTurn)).stream()
                .filter(message -> message.getType() == SessionMessageType.USER).findFirst().orElseThrow().getId();
        mvc.perform(get("/session/{id}/messages", sessionId)).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.turnViews['" + newTurn + "'].userMessage").value("改写后的问题"))
                .andExpect(jsonPath("$.data.turnViews['" + newTurn + "'].userMessageId").value(newUserMessageId.toString()));
    }

    private JsonNode accept(Long sessionId, String input) throws Exception {
        return mapper.readTree(mvc.perform(multipart("/a/completion/commands")
                        .param("sessionId", sessionId.toString()).param("input", input).param("modelId", "7"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(1))
                .andReturn().getResponse().getContentAsString()).path("data");
    }

    @Test
    void rejectedResendAdmissionKeepsTheOriginalHistory() throws Exception {
        Long sessionId = sessions.initialize("重发受理失败验证", null, null).getData();
        Long turnId = Long.valueOf(accept(sessionId, "必须保留的原问题").path("turnId").asText());
        waitForState(sessionId, 3);
        SessionMessage original = messages.findByTurnIds(sessionId, List.of(turnId)).stream()
                .filter(message -> message.getType() == SessionMessageType.USER).findFirst().orElseThrow();
        doThrow(new ClientException("模拟执行登记失败")).when(orchestrator).createExecution(any());
        mvc.perform(multipart("/a/completion/resend").param("sessionId", sessionId.toString())
                        .param("messageId", original.getId().toString()).param("input", "不能受理的新问题").param("modelId", "7"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0));
        assertTrue(turns.findById(turnId).isPresent(), "重发未受理，原轮次不能被删除");
        assertTrue(messages.findById(original.getId()).isPresent(), "重发未受理，原提问不能被删除");
    }

    private ExecutionPO latest(Long sessionId) {
        List<ExecutionPO> rows = executions.selectList(Wrappers.<ExecutionPO>lambdaQuery()
                .eq(ExecutionPO::getSessionId, sessionId).orderByDesc(ExecutionPO::getId));
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private void waitForState(Long sessionId, int state) {
        await().atMost(Duration.ofSeconds(8)).untilAsserted(() -> {
            ExecutionPO row = latest(sessionId);
            assertNotNull(row);
            assertEquals(state, row.getStatus());
            if (state == 2 || state == 3) assertTrue(finishedRuns.contains(row.getId().toString()));
        });
    }

    private static ChatResponseEntity reply(String text) {
        return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text(text).build())
                .tokenUsage(TokenUsageEntity.of(10, 5, 0)).build();
    }
}
