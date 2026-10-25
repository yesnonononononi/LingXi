package com.summit.dp.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.ModelRetryConfig;
import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.event.InvokeRetryEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.model.streaming.StreamingChatModel;
import com.summit.core.runtime.RuntimeListener;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.tool.ToolExecuteCommand;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecutionManager;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.config.ModelHttpClientConfiguration;
import com.summit.dp.workflow.infrastructure.listener.agent.AgentEventListener;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import com.summit.harness.springbootautoconfigure.config.ModelProviderConfig;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.loop.BoundaryChecker;
import com.summit.runtime.loop.DefaultExecutionController;
import com.summit.runtime.loop.DefaultLoopInterceptor;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.loop.DefaultRuntimeLifeStyleManager;
import com.summit.runtime.loop.RuntimeProcessorTemplate;
import com.summit.runtime.loop.control.InMemoryActiveExecutionRegistry;
import com.summit.runtime.model.DefaultRequestModelInvokerFactory;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 同一套真实网络故障贯穿模型选择、执行终态与业务事件，连接器由运行参数切换。 */
class HttpClientNetworkComparisonTest {
    private static final String CLIENT = System.getProperty("lingxi.network.client", "OKHTTP");
    private static final List<Measurement> RESULTS = new CopyOnWriteArrayList<>();
    private static final AtomicInteger IDS = new AtomicInteger(1000);

    enum Scenario {
        SUCCESS, HTTP_503, HTTP_429, AUTH_401, QUOTA, SSE_ERROR, TRUNCATED,
        HEADER_TIMEOUT, IDLE_TIMEOUT, LONG_STREAM, EXHAUSTED,
        CANCEL_IDLE, CANCEL_STREAM, HEADER_EOF, REFUSED, TLS_EOF, TLS_CERTIFICATE
    }

    static Stream<Arguments> cases() {
        return Stream.of(false, true).flatMap(anthropic -> Stream.of(Scenario.values())
                .map(scenario -> Arguments.of(anthropic, scenario)));
    }

    @ParameterizedTest(name = "anthropic={0}, scenario={1}")
    @MethodSource("cases")
    void comparesNetworkFailureThroughBusinessEvents(boolean anthropic, Scenario scenario) throws Exception {
        try (Endpoint endpoint = endpoint(scenario, anthropic); Harness harness = new Harness(endpoint, anthropic)) {
            Measurement result = harness.run(endpoint, scenario, anthropic);
            RESULTS.add(result);
            boolean cancelled = scenario == Scenario.CANCEL_IDLE || scenario == Scenario.CANCEL_STREAM;
            boolean failed = scenario == Scenario.AUTH_401 || scenario == Scenario.QUOTA
                    || scenario == Scenario.EXHAUSTED || scenario == Scenario.REFUSED
                    || scenario == Scenario.TLS_EOF || scenario == Scenario.TLS_CERTIFICATE;
            String expected = cancelled ? "CANCELLED" : failed ? "FAILED" : "COMPLETED";
            assertEquals(expected, result.state(), result.toString());
            assertTrue(result.modelAttempts() >= 1 && result.modelAttempts() <= 3, result.toString());
            assertEquals(result.modelAttempts() - 1, result.retryEvents(), result.toString());
            assertEquals(1, harness.capture.frames.stream().filter(frame -> Set.of(
                    "EXECUTION_FAILED", "EXECUTION_CANCELLED", "EXECUTION_COMPLETED")
                    .contains(frame.path("type").asText())).count());
            if (failed) {
                assertFalse(result.error().isBlank(), result.toString());
                assertEquals(0, result.totalTokens());
            } else if (!cancelled) {
                assertEquals(5, result.totalTokens(), result.toString());
                assertEquals(1, harness.capture.frames.stream()
                        .filter(frame -> frame.path("type").asText().equals("AI_MESSAGE")).count());
            }
            if (scenario == Scenario.AUTH_401 || scenario == Scenario.QUOTA || scenario == Scenario.TLS_CERTIFICATE) {
                assertEquals(1, result.modelAttempts(), result.toString());
            }
            if (scenario == Scenario.EXHAUSTED || scenario == Scenario.REFUSED) {
                assertEquals(3, result.modelAttempts(), result.toString());
            }
            if (scenario == Scenario.TLS_EOF) {
                assertEquals(3, result.modelAttempts(), result.toString());
            }
            if (scenario == Scenario.LONG_STREAM || scenario == Scenario.SUCCESS || cancelled) {
                assertEquals(1, result.modelAttempts(), result.toString());
            }
            if (scenario == Scenario.IDLE_TIMEOUT) {
                assertEquals(CLIENT.equals("OKHTTP") ? 2 : 1, result.modelAttempts(), result.toString());
            }
            if (cancelled) {
                assertTrue(result.cancellationMillis() < 1000, result.toString());
                assertTrue(endpoint.disconnected.await(3, TimeUnit.SECONDS), "取消必须关闭实际连接");
                assertEquals(0, harness.capture.frames.stream()
                        .filter(frame -> frame.toString().contains("late-after-cancel")).count());
            }
        }
    }

    @Test
    void recordsWarmLatencyAndConnectionReuse() throws Exception {
        try (Endpoint endpoint = endpoint(Scenario.SUCCESS, false); Harness harness = new Harness(endpoint, false)) {
            int warmup = Integer.getInteger("lingxi.network.warmup", 5);
            int samples = Integer.getInteger("lingxi.network.samples", 30);
            assertTrue(warmup > 0 && samples > 0);
            for (int index = 0; index < warmup; index++) harness.run(endpoint, Scenario.SUCCESS, false);
            for (int index = 0; index < samples; index++) {
                Measurement result = harness.run(endpoint, Scenario.SUCCESS, false);
                assertEquals("COMPLETED", result.state());
                assertEquals(1, result.modelAttempts());
                RESULTS.add(new Measurement(result.client(), result.protocol(), "WARM_SUCCESS", result.state(),
                        result.modelAttempts(), result.retryEvents(), result.wireRequests(), result.connections(),
                        result.elapsedMillis(), result.cancellationMillis(), result.totalTokens(), result.error()));
            }
            assertEquals(warmup + samples, endpoint.requests.get());
            assertTrue(endpoint.connections.size() < warmup + samples, "必须有实际连接复用才可讨论收益");
        }
    }

    @AfterAll
    static void exportMeasurements() throws IOException {
        Path output = Path.of(System.getProperty("lingxi.network.output", "target/http-client-comparison/" + CLIENT + ".json"));
        Files.createDirectories(output.toAbsolutePath().getParent());
        new ObjectMapper().writerWithDefaultPrettyPrinter().writeValue(output.toFile(), RESULTS);
    }

    private static Endpoint endpoint(Scenario scenario, boolean anthropic) throws Exception {
        if (scenario == Scenario.HEADER_EOF || scenario == Scenario.TLS_EOF || scenario == Scenario.REFUSED) {
            return new RawEndpoint(scenario, anthropic);
        }
        return new HttpEndpoint(scenario, anthropic);
    }

    private record Measurement(String client, String protocol, String scenario, String state,
                               long modelAttempts, long retryEvents, int wireRequests, int connections,
                               double elapsedMillis, double cancellationMillis, long totalTokens, String error) { }

    private static final class Harness implements AutoCloseable {
        private final AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext();
        private final ExecutorService worker = Executors.newVirtualThreadPerTaskExecutor();
        private final Capture capture = new Capture();
        private final InMemoryActiveExecutionRegistry repository = new InMemoryActiveExecutionRegistry();
        private final RuntimeProcessorTemplate runtime;
        private final ModelConfig config;

        @SuppressWarnings("unchecked")
        private Harness(Endpoint endpoint, boolean anthropic) throws Exception {
            if (CLIENT.equals("OKHTTP")) {
                context.register(ModelHttpClientConfiguration.class);
            } else {
                assertEquals("JDK", CLIENT, "未知连接器不能悄悄退回默认实现");
            }
            context.register(ModelProviderConfig.class);
            context.refresh();
            String provider = anthropic ? DefaultModelProviderNames.ANTHROPIC_STREAMING : DefaultModelProviderNames.DEFAULT_STREAMING;
            config = ModelConfig.builder().baseUrl(endpoint.baseUrl()).apiKey("test-key").modelName("probe")
                    .provider(provider).maxTokens(1024).timeout(Duration.ofMillis(350)).maxRetries(0).build();
            ModelProviderRegistry<ChatModel> chats = context.getBean("chatModelProviderRegistry", ModelProviderRegistry.class);
            ModelProviderRegistry<StreamingChatModel> streams = context.getBean("streamingModelProviderRegistry", ModelProviderRegistry.class);
            DefaultRequestModelInvokerFactory invokers = new DefaultRequestModelInvokerFactory(provider, config, chats, streams);
            ExecutionLocator locator = mock(ExecutionLocator.class);
            when(locator.sessionId(anyString())).thenReturn(7L);
            when(locator.resolveRootSessionId(7L)).thenReturn(7L);
            AgentEventListener bridge = new AgentEventListener(capture.json, capture, locator);
            bridge.init();
            RuntimeEventPublisher events = new RuntimeEventPublisher(List.of(bridge, new RuntimeListener() {
                @Override
                public void onInvokeRetry(InvokeRetryEvent event) { endpoint.retrySeen.countDown(); }
            }));
            DefaultConversationManager conversations = new DefaultConversationManager(ContextAttachmentProvider.NONE);
            DefaultTokenizer tokenizer = new DefaultTokenizer();
            DefaultRuntimeLifeStyleManager lifecycle = new DefaultRuntimeLifeStyleManager(events);
            ToolExecutionManager tools = new ToolExecutionManager() {
                public List<ToolExecuteResult> execute(ToolExecuteCommand command) { return List.of(); }
                public ToolRegistry toolRegistry() { return new ToolRegistry(List.of()); }
            };
            runtime = new RuntimeProcessorTemplate(RuntimeContext.builder()
                    .executionRepository(repository).conversationManager(conversations)
                    .executionControl(new DefaultExecutionController(() -> null, repository, events, lifecycle))
                    .runtimeLifeStyleManager(lifecycle).runtimeEventPublisher(events).toolExecutionManager(tools)
                    .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(new DefaultLoopInterceptor())))
                    .runtimeBoundaryChecker(new BoundaryChecker(AgentConfig.builder().maxIterations(5).build(), tokenizer,
                            conversations, null, null)).usage(new ContextUsageReporter(tokenizer, 64000, events, 1))
                    .invoker(invokers.select(config).invoker()).build());
        }

        private Measurement run(Endpoint endpoint, Scenario scenario, boolean anthropic) throws Exception {
            capture.frames.clear();
            String executionId = String.valueOf(IDS.incrementAndGet());
            AgentRequest request = AgentRequest.builder().messages(List.of(UserMessageEntity.from("question")))
                    .systemPrompt("Answer the question.")
                    .retryConfig(ModelRetryConfig.builder().enabled(true).maxRetries(2)
                            .initialDelay(Duration.ZERO).maxDelay(Duration.ZERO).build()).build();
            request.runtimeParametersOrDefault().setEventMetaData(Map.of("rootSessionId", "7", "sessionId", "7", "turnId", "900"));
            Execution execution = Execution.create(request, "network-test");
            execution.setId(executionId);
            execution.setStreaming(true);
            execution.setMaxSteps(5);
            long started = System.nanoTime();
            Future<?> task = worker.submit(() -> runtime.execute(execution));
            long cancelledAt = 0;
            if (scenario == Scenario.CANCEL_IDLE || scenario == Scenario.CANCEL_STREAM) {
                assertTrue(endpoint.ready.await(5, TimeUnit.SECONDS), "取消前必须进入真实请求");
                if (scenario == Scenario.CANCEL_STREAM) assertTrue(capture.partial.await(3, TimeUnit.SECONDS));
                cancelledAt = System.nanoTime();
                repository.requireCancel(executionId);
            }
            Throwable failure = null;
            try {
                task.get(8, TimeUnit.SECONDS);
            } catch (ExecutionException error) {
                failure = error.getCause();
            }
            long finished = System.nanoTime();
            long retries = capture.frames.stream().filter(frame -> frame.path("type").asText().equals("INVOKE_RETRY")).count();
            for (JsonNode frame : capture.frames) {
                if (!frame.path("type").asText().equals("INVOKE_RETRY")) continue;
                assertEquals("900", frame.path("metaData").path("turnId").asText());
                assertTrue(frame.path("retryDelay").isNumber());
                assertFalse(frame.path("responseId").asText().isBlank());
            }
            return new Measurement(CLIENT, anthropic ? "ANTHROPIC" : "OPENAI", scenario.name(),
                    execution.getExecutionState().name(), execution.getModelAttempts(), retries,
                    endpoint.requests.get(), endpoint.connectionCount(), (finished - started) / 1_000_000.0,
                    cancelledAt == 0 ? 0 : (finished - cancelledAt) / 1_000_000.0,
                    execution.getTokenUsage().getTotalTokens(), failure == null ? "" : failure.toString());
        }

        public void close() {
            worker.shutdownNow();
            capture.close();
            context.close();
        }
    }

    private static final class Capture extends SseEventPublisher implements AutoCloseable {
        private final ObjectMapper json = new JsonConfig().objectMapper();
        private final List<JsonNode> frames = new CopyOnWriteArrayList<>();
        private final CountDownLatch partial = new CountDownLatch(1);

        public void publish(long rootSessionId, AgentEvent event) { frames.add(json.valueToTree(event)); }
        public void publishBusiness(long rootSessionId, String name, Object payload) {
            assertEquals(7L, rootSessionId);
            frames.add(json.valueToTree(payload));
            if (name.equals("PARTIAL_TEXT")) partial.countDown();
        }
    }

    private abstract static class Endpoint implements AutoCloseable {
        final AtomicInteger requests = new AtomicInteger();
        final Set<Integer> connections = ConcurrentHashMap.newKeySet();
        final CountDownLatch ready = new CountDownLatch(1);
        final CountDownLatch retrySeen = new CountDownLatch(1);
        final CountDownLatch disconnected = new CountDownLatch(1);
        abstract String baseUrl();
        int connectionCount() { return connections.size(); }
        public abstract void close();
    }

    private static final class HttpEndpoint extends Endpoint {
        private final HttpServer server;
        private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();
        private final boolean tls;

        private HttpEndpoint(Scenario scenario, boolean anthropic) throws Exception {
            tls = scenario == Scenario.TLS_CERTIFICATE;
            if (tls) {
                HttpsServer secure = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                secure.setHttpsConfigurator(new HttpsConfigurator(serverTls()));
                server = secure;
            } else {
                server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            }
            server.setExecutor(workers);
            server.createContext("/", exchange -> {
                connections.add(exchange.getRemoteAddress().getPort());
                int attempt = requests.incrementAndGet();
                if (Set.of(Scenario.HTTP_503, Scenario.HTTP_429, Scenario.AUTH_401, Scenario.QUOTA,
                        Scenario.SSE_ERROR, Scenario.TRUNCATED, Scenario.HEADER_TIMEOUT).contains(scenario)) {
                    String suffix = switch (scenario) {
                        case HTTP_503 -> "503";
                        case HTTP_429 -> "429";
                        case AUTH_401 -> "401";
                        case QUOTA -> "QUOTA";
                        case SSE_ERROR -> "SSE";
                        case TRUNCATED -> "TRUNCATED";
                        case HEADER_TIMEOUT -> "TIMEOUT";
                        default -> throw new IllegalStateException();
                    };
                    StreamingRetryContractTest.respond(exchange, "OPENAI_" + suffix, anthropic, attempt, retrySeen);
                    return;
                }
                try (exchange) {
                    exchange.getRequestBody().readAllBytes();
                    if (scenario == Scenario.EXHAUSTED) {
                        byte[] body = "{\"error\":{\"type\":\"server_error\",\"message\":\"unavailable\"}}".getBytes(StandardCharsets.UTF_8);
                        exchange.getResponseHeaders().set("Content-Type", "application/json");
                        exchange.sendResponseHeaders(503, body.length);
                        exchange.getResponseBody().write(body);
                        return;
                    }
                    exchange.getResponseHeaders().set("Content-Type", "text/event-stream");
                    exchange.sendResponseHeaders(200, 0);
                    write(exchange, prefix(anthropic));
                    if (scenario == Scenario.CANCEL_IDLE) {
                        ready.countDown();
                        pause(500);
                        for (int index = 0; index < 40; index++) {
                            write(exchange, delta(anthropic, "late-after-cancel"));
                            pause(50);
                        }
                        return;
                    }
                    write(exchange, delta(anthropic, "answer"));
                    ready.countDown();
                    if (scenario == Scenario.CANCEL_STREAM) {
                        for (int index = 0; index < 50; index++) {
                            pause(50);
                            write(exchange, delta(anthropic, "late-after-cancel"));
                        }
                    } else if (scenario == Scenario.IDLE_TIMEOUT && attempt == 1) {
                        pause(1200);
                    } else if (scenario == Scenario.LONG_STREAM) {
                        for (int index = 0; index < 10; index++) {
                            pause(80);
                            write(exchange, delta(anthropic, "more"));
                        }
                    }
                    write(exchange, ending(anthropic));
                } catch (IOException expected) {
                    disconnected.countDown();
                }
            });
            server.start();
        }

        String baseUrl() { return (tls ? "https" : "http") + "://127.0.0.1:" + server.getAddress().getPort() + "/v1"; }
        public void close() { server.stop(0); workers.shutdownNow(); }
    }

    private static final class RawEndpoint extends Endpoint {
        private final ServerSocket server = new ServerSocket(0, 20, InetAddress.getLoopbackAddress());
        private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();
        private final AtomicInteger accepted = new AtomicInteger();
        private final boolean tls;
        private final int port = server.getLocalPort();

        private RawEndpoint(Scenario scenario, boolean anthropic) throws IOException {
            tls = scenario == Scenario.TLS_EOF;
            if (scenario == Scenario.REFUSED) {
                server.close();
                return;
            }
            workers.submit(() -> {
                while (!server.isClosed()) {
                    try {
                        Socket socket = server.accept();
                        accepted.incrementAndGet();
                        workers.submit(() -> {
                            try (socket) {
                                socket.setSoTimeout(3000);
                                InputStream input = socket.getInputStream();
                                if (tls) {
                                    byte[] header = input.readNBytes(5);
                                    if (header.length == 5) input.readNBytes(((header[3] & 255) << 8) + (header[4] & 255));
                                    return;
                                }
                                StringBuilder headers = new StringBuilder();
                                while (!headers.toString().endsWith("\r\n\r\n")) {
                                    int next = input.read();
                                    if (next < 0) return;
                                    headers.append((char) next);
                                }
                                for (String line : headers.toString().split("\r\n")) {
                                    if (line.toLowerCase().startsWith("content-length:")) input.readNBytes(Integer.parseInt(line.substring(15).trim()));
                                }
                                int request = requests.incrementAndGet();
                                if (request == 1) { socket.setSoLinger(true, 0); return; }
                                byte[] body = (prefix(anthropic) + delta(anthropic, "answer") + ending(anthropic)).getBytes(StandardCharsets.UTF_8);
                                socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: "
                                        + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                                socket.getOutputStream().write(body);
                                socket.getOutputStream().flush();
                            } catch (IOException expected) { disconnected.countDown(); }
                        });
                    } catch (IOException expected) {
                        if (!server.isClosed()) throw new IllegalStateException(expected);
                    }
                }
            });
        }

        String baseUrl() { return (tls ? "https" : "http") + "://127.0.0.1:" + port + "/v1"; }
        int connectionCount() { return accepted.get(); }
        public void close() {
            try { server.close(); } catch (IOException error) { throw new IllegalStateException(error); }
            workers.shutdownNow();
        }
    }

    private static void write(HttpExchange exchange, String text) throws IOException {
        exchange.getResponseBody().write(text.getBytes(StandardCharsets.UTF_8));
        exchange.getResponseBody().flush();
    }

    private static void pause(long millis) {
        try { Thread.sleep(millis); } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
    }

    private static String prefix(boolean anthropic) {
        return anthropic ? "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"probe\",\"content\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n" : ": ready\n\n";
    }

    private static String delta(boolean anthropic, String text) {
        return anthropic ? "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"" + text + "\"}}\n\n"
                : "data: {\"id\":\"m\",\"model\":\"probe\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"" + text + "\"}}]}\n\n";
    }

    private static String ending(boolean anthropic) {
        return anthropic ? "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                : "data: {\"id\":\"m\",\"model\":\"probe\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\ndata: [DONE]\n\n";
    }

    private static synchronized SSLContext serverTls() throws Exception {
        Path directory = Path.of(System.getProperty("java.io.tmpdir"), "lingxi-network-test-tls");
        Files.createDirectories(directory);
        Path store = directory.resolve("localhost.p12");
        char[] password = "local-test-only".toCharArray();
        if (!Files.exists(store)) {
            String executable = System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win") ? "keytool.exe" : "keytool";
            Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", executable).toString(),
                    "-genkeypair", "-alias", "localhost", "-keyalg", "RSA", "-keystore", store.toString(),
                    "-storetype", "PKCS12", "-storepass", "local-test-only", "-keypass", "local-test-only",
                    "-dname", "CN=localhost", "-ext", "SAN=ip:127.0.0.1,dns:localhost", "-validity", "2", "-noprompt")
                    .redirectErrorStream(true).redirectOutput(directory.resolve("keytool.log").toFile()).start();
            assertTrue(process.waitFor(15, TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
        }
        KeyStore keys = KeyStore.getInstance("PKCS12");
        try (InputStream input = Files.newInputStream(store)) { keys.load(input, password); }
        KeyManagerFactory managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        managers.init(keys, password);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(managers.getKeyManagers(), null, null);
        return context;
    }
}
