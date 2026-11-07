package com.summit.dp.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.ModelRetryConfig;
import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.event.InvokeRetryEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.streaming.StreamingChatModel;
import com.summit.core.runtime.RuntimeListener;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.tool.ToolExecuteCommand;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecutionManager;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.listener.agent.AgentEventListener;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.loop.*;
import com.summit.runtime.loop.control.InMemoryActiveExecutionRegistry;
import com.summit.runtime.model.DefaultStreamingModelInvoker;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import anthropic.AnthropicChatModel;
import openAi.DefaultChatModel;
import openAi.MessageSerializer;
import openAi.ModelChatResolver;
import openAi.RequestBodyFactory;
import openAi.ResponseSerializer;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 模型故障必须贯穿适配器、重试、执行终态和业务事件序列化。
 *
 * <p>迁移说明：LangChain4j 模型适配器已退役，模型调用改走框架自有的
 * {@code openAi.DefaultChatModel} / {@code anthropic.AnthropicChatModel}（端口为
 * {@code com.summit.core.model.streaming.StreamingChatModel}），本地假端点收到的仍是真实线上协议流量。</p>
 *
 * <p>429 有两档：{@code insufficient_quota}（配额耗尽）是终态，一次请求就失败、不重试；
 * {@code rate_limit_error} 只是限流，仍会重试一次并完成。两档都在下面锁着，
 * 免得"把配额耗尽当限流重试"这种真花钱的回归悄悄回来。</p>
 */
class StreamingRetryContractTest {
    @ParameterizedTest
    @ValueSource(strings = {"OPENAI_SSE", "ANTHROPIC_SSE", "OPENAI_503", "OPENAI_429", "OPENAI_TIMEOUT",
            "OPENAI_TRUNCATED", "OPENAI_STREAM_ABORT", "OPENAI_401", "OPENAI_QUOTA", "OPENAI_RATE_LIMIT",
            "OPENAI_BUDGET"})
    void providerFailureTraversesRuntimeAndBusinessStream(String mode) throws Exception {
        AtomicInteger requests = new AtomicInteger();
        CountDownLatch retrySeen = new CountDownLatch(1);
        boolean anthropic = mode.startsWith("ANTHROPIC");
        // 401（鉴权失败）与 429+insufficient_quota（配额耗尽）都是终态：一次请求就失败，不发重试通知。
        boolean retryRefused = mode.endsWith("401") || mode.endsWith("QUOTA");
        // 步数预算只剩一轮：重试通知照发，第二次尝试被边界检查挡下，网络只打一次。
        boolean budgetExhausted = mode.endsWith("BUDGET");
        boolean completed = !retryRefused && !budgetExhausted;
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        try (ExecutorService workers = Executors.newCachedThreadPool(); Capture stream = new Capture()) {
            server.setExecutor(workers);
            server.createContext("/", exchange -> respond(exchange, mode, anthropic, requests.incrementAndGet(), retrySeen));
            server.start();
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            // 旧实现包一层 StreamingChatModelAdapter(OpenAiStreamingChatModel/AnthropicStreamingChatModel)；
            // 适配器退役后直接用框架自有实现，本地假端点收到的仍是真实线上协议流量。
            StreamingChatModel model = anthropic
                    ? anthropicStreamingModel(base, Duration.ofSeconds(3))
                    : openAiStreamingModel(base + "/v1", mode.endsWith("TIMEOUT") ? Duration.ofMillis(500) : Duration.ofSeconds(3));
            ExecutionLocator locator = mock(ExecutionLocator.class);
            when(locator.sessionId("101")).thenReturn(7L);
            when(locator.resolveRootSessionId(7L)).thenReturn(7L);
            AgentEventListener bridge = new AgentEventListener(stream.json, stream, locator, mock(ExecutionRepository.class));
            bridge.init();
            RuntimeEventPublisher events = new RuntimeEventPublisher(List.of(bridge, new RuntimeListener() {
                public void onInvokeRetry(InvokeRetryEvent event) { retrySeen.countDown(); }
            }));
            AgentRequest request = AgentRequest.builder().messages(List.of(UserMessageEntity.from("question")))
                    .systemPrompt("Answer the question.")
                    .retryConfig(ModelRetryConfig.builder().enabled(true).maxRetries(2)
                            .initialDelay(Duration.ZERO).maxDelay(Duration.ZERO).build()).build();
            request.runtimeParametersOrDefault().setEventMetaData(Map.of("rootSessionId", "7", "sessionId", "7", "turnId", "900"));
            Execution execution = Execution.create(request, "agent");
            execution.setId("101");
            execution.setStreaming(true);
            execution.setMaxSteps(mode.endsWith("BUDGET") ? 1 : 5);
            InMemoryActiveExecutionRegistry repository = new InMemoryActiveExecutionRegistry();
            DefaultConversationManager conversations = new DefaultConversationManager(ContextAttachmentProvider.NONE);
            DefaultTokenizer tokenizer = new DefaultTokenizer();
            DefaultRuntimeLifeStyleManager lifecycle = new DefaultRuntimeLifeStyleManager(events);
            ToolExecutionManager tools = new ToolExecutionManager() {
                public List<ToolExecuteResult> execute(ToolExecuteCommand command) { return List.of(); }
                public ToolRegistry toolRegistry() { return new ToolRegistry(List.of()); }
            };
            RuntimeProcessorTemplate runtime = new RuntimeProcessorTemplate(RuntimeContext.builder()
                    .executionRepository(repository).conversationManager(conversations)
                    .executionControl(new DefaultExecutionController(() -> null, repository, events, lifecycle))
                    .runtimeLifeStyleManager(lifecycle).runtimeEventPublisher(events).toolExecutionManager(tools)
                    .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(new DefaultLoopInterceptor())))
                    .runtimeBoundaryChecker(new BoundaryChecker(AgentConfig.builder().maxIterations(5).build(), tokenizer,
                            conversations, null, null)).usage(new ContextUsageReporter(tokenizer, 64000, events, 1))
                    .invoker(new DefaultStreamingModelInvoker(model)).build());
            if (!completed) assertThrows(RuntimeException.class, () -> runtime.execute(execution));
            else runtime.execute(execution);

            assertEquals(completed ? 2 : 1, requests.get());
            assertEquals(completed ? ExecutionState.COMPLETED : ExecutionState.FAILED, execution.getExecutionState());
            assertEquals(completed ? 2 : 1, execution.getModelAttempts());
            assertEquals(completed ? 5 : 0, execution.getTokenUsage().getTotalTokens());
            List<JsonNode> notices = stream.frames.stream().filter(frame -> frame.path("type").asText().equals("INVOKE_RETRY")).toList();
            // 401 不产生重试通知；预算耗尽会通知一次重试但不再发请求；其余都要通知一次并真的重试。
            assertEquals(retryRefused ? 0 : 1, notices.size());
            for (JsonNode notice : notices) {
                assertEquals("900", notice.path("metaData").path("turnId").asText());
                assertEquals("MILLISECONDS", notice.path("timeUnit").asText());
                assertFalse(notice.path("responseId").asText().isBlank());
            }
            assertEquals(1, stream.frames.stream().filter(frame -> frame.path("type").asText()
                    .equals(completed ? "EXECUTION_COMPLETED" : "EXECUTION_FAILED")).count());
            assertEquals(0, stream.frames.stream().filter(frame -> frame.path("content").asText().equals("late")).count());
            if (completed) {
                assertEquals(1, stream.frames.stream().filter(frame -> frame.path("type").asText().equals("AI_MESSAGE")).count());
                JsonNode terminal = stream.frames.stream().filter(frame -> frame.path("type").asText().equals("EXECUTION_COMPLETED")).findFirst().orElseThrow();
                assertEquals(5, terminal.path("tokenInfo").path("totalTokenCount").asInt());
            }
            String export = System.getProperty("lingxi.retry.contract.output");
            if (export != null && mode.equals("OPENAI_SSE")) stream.json.writeValue(Path.of(export).toFile(), stream.frames);
        } finally {
            server.stop(0);
        }
    }

    /** 框架自带的 OpenAI 协议流式实现：连本地假端点，流式开关和重试都由框架自己决定。 */
    private static StreamingChatModel openAiStreamingModel(String baseUrl, Duration timeout) {
        ObjectMapper mapper = new ObjectMapper();
        ModelConfig config = ModelConfig.builder()
                .provider(DefaultModelProviderNames.DEFAULT_STREAMING)
                .baseUrl(baseUrl).apiKey("test").modelName("probe").timeout(timeout).build();
        return new DefaultChatModel(config, chatResolver(mapper),
                HttpClient.newBuilder().connectTimeout(timeout).build());
    }

    /** 框架自带的 Anthropic 流式实现；同一实现同时提供同步与流式端口。 */
    private static StreamingChatModel anthropicStreamingModel(String baseUrl, Duration timeout) {
        ModelConfig config = ModelConfig.builder()
                .provider(DefaultModelProviderNames.ANTHROPIC_STREAMING)
                .baseUrl(baseUrl).apiKey("test").modelName("probe").maxTokens(100).timeout(timeout).build();
        return new AnthropicChatModel(config, HttpClient.newBuilder().connectTimeout(timeout).build(), new ObjectMapper());
    }

    private static ModelChatResolver chatResolver(ObjectMapper mapper) {
        return new ModelChatResolver(new RequestBodyFactory(new MessageSerializer(mapper), mapper), mapper, new ResponseSerializer());
    }

    static void respond(HttpExchange exchange, String mode, boolean anthropic, int request,
                                CountDownLatch retrySeen) throws IOException {
        try (exchange) {
            exchange.getRequestBody().readAllBytes();
            if (request == 1 && mode.endsWith("ABORT")) {
                // 生产事故现场：响应头已经下发、正文只到一半就被对端重置。
                // 旧栈（okhttp）里这是 StreamResetException(HTTP/2 RST_STREAM)；新栈（java.net.http）里表现为
                // 流中途 IOException / 提前结束。两者都必须被模型实现判成可重试，而不是直接终结执行。
                exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, 0);
                exchange.getResponseBody().write(("data: {\"id\":\"m\",\"model\":\"probe\",\"choices\":[{\"index\":0,"
                        + "\"delta\":{\"content\":\"discard\"}}]}\n\n").getBytes(StandardCharsets.UTF_8));
                exchange.getResponseBody().flush();
                return;
            }
            if (request == 1 && mode.endsWith("TIMEOUT")) {
                try { Thread.sleep(1500); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                return;
            }
            if (request == 1 && !(mode.endsWith("SSE") || mode.endsWith("TRUNCATED"))) {
                int status = mode.endsWith("401") ? 401
                        : mode.endsWith("429") || mode.endsWith("QUOTA") || mode.endsWith("RATE_LIMIT") ? 429 : 503;
                String type = mode.endsWith("QUOTA") ? "insufficient_quota"
                        : mode.endsWith("RATE_LIMIT") ? "rate_limit_error"
                        : status == 401 ? "authentication_error" : "server_error";
                byte[] body = ("{\"error\":{\"type\":\"" + type + "\",\"message\":\"temporary\"}}").getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(status, body.length);
                exchange.getResponseBody().write(body);
                return;
            }
            exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, mode.endsWith("TRUNCATED") && request == 1 ? 4096 : 0);
            String start = anthropic ? "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"probe\",\"content\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n" : "";
            String text = request == 1 ? "discard" : "recovered";
            String delta = anthropic ? "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"" + text + "\"}}\n\n"
                    : "data: {\"id\":\"m\",\"model\":\"probe\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"" + text + "\"}}]}\n\n";
            exchange.getResponseBody().write((start + delta).getBytes(StandardCharsets.UTF_8));
            exchange.getResponseBody().flush();
            if (request == 1) {
                if (mode.endsWith("TRUNCATED")) return;
                exchange.getResponseBody().write("event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"temporary\"}}\n\n".getBytes(StandardCharsets.UTF_8));
                exchange.getResponseBody().flush();
                try { retrySeen.await(2, TimeUnit.SECONDS); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
                exchange.getResponseBody().write("data: {\"id\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"late\"}}]}\n\n".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String end = anthropic ? "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                    : "data: {\"id\":\"m\",\"model\":\"probe\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\ndata: [DONE]\n\n";
            exchange.getResponseBody().write(end.getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            // 取消后的旧连接允许写入失败，客户端不得再接收其中的片段。
        }
    }

    private static final class Capture extends SseEventPublisher implements AutoCloseable {
        private final ObjectMapper json = new JsonConfig().objectMapper();
        private final List<JsonNode> frames = new CopyOnWriteArrayList<>();
        public void publish(long rootSessionId, AgentEvent event) {
            assertEquals(7L, rootSessionId);
            frames.add(json.valueToTree(event));
        }
        public void publishBusiness(long rootSessionId, String name, Object payload) {
            assertEquals(7L, rootSessionId);
            frames.add(json.valueToTree(payload));
        }
    }
}
