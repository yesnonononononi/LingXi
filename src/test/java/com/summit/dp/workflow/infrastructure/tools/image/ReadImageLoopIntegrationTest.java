package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.runtime.model.DefaultChatModelInvoker;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.adapter.langchain4j.model.ChatModelAdapter;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.CheckPointResult;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.core.runtime.loop.RuntimeBoundaryChecker;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutionContext;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.config.FileToolConfiguration;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.loop.AgentLoopStepRunner;
import com.summit.runtime.loop.DefaultLoopInterceptor;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.tool.DefaultToolExecutionManager;
import com.summit.runtime.workspace.LocalWorkspace;
import com.sun.net.httpserver.HttpServer;
import dev.langchain4j.http.client.okhttp.OkHttpClient;
import dev.langchain4j.model.openai.OpenAiChatModel;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 本地模型端点见证真实工具轮后的图片请求，不依赖外部模型或密钥。 */
class ReadImageLoopIntegrationTest {
    @TempDir Path workspaceRoot;
    @TempDir Path dataDir;

    @Test
    void toolRoundSendsConvertedPixelsAfterTheToolReceipt() throws Exception {
        BufferedImage source = new BufferedImage(16, 8, BufferedImage.TYPE_INT_RGB);
        source.setRGB(0, 0, 0x123456);
        assertTrue(ImageIO.write(source, "bmp", workspaceRoot.resolve("sample.bmp").toFile()));
        ObjectMapper mapper = new ObjectMapper();
        List<JsonNode> requests = new CopyOnWriteArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            try (exchange) {
                requests.add(mapper.readTree(exchange.getRequestBody()));
                ObjectNode response = mapper.createObjectNode().put("id", "local-response")
                        .put("object", "chat.completion").put("model", "arbitrary-vision-model");
                ObjectNode choice = response.putArray("choices").addObject().put("index", 0);
                ObjectNode message = choice.putObject("message").put("role", "assistant");
                if (requests.size() == 1) {
                    choice.put("finish_reason", "tool_calls");
                    ObjectNode call = message.putArray("tool_calls").addObject().put("id", "read-call").put("type", "function");
                    call.putObject("function").put("name", ToolCatalog.READ_IMAGE)
                            .put("arguments", mapper.writeValueAsString(Map.of("path", "sample.bmp")));
                } else {
                    choice.put("finish_reason", "stop");
                    message.put("content", "received image");
                }
                byte[] bytes = mapper.writeValueAsBytes(response);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
            }
        });
        server.start();
        try {
            ImageCacheDirectory cache = new ImageCacheDirectory(dataDir.toString());
            ToolDefinition<ReadImageToolExecutor> definition = new FileToolConfiguration().readImageToolDefinition(
                    mapper, new ImageNormalizer(), cache);
            RuntimeEventPublisher events = new RuntimeEventPublisher(List.of());
            ChatModelAdapter model = new ChatModelAdapter(OpenAiChatModel.builder()
                    .httpClientBuilder(OkHttpClient.builder())
                    .baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1")
                    .apiKey("local-test-key").modelName("arbitrary-vision-model").timeout(Duration.ofSeconds(5)).maxRetries(0).build());
            AgentRequest request = AgentRequest.builder().toolList(List.of(ToolCatalog.READ_IMAGE))
                    .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                            ExecutionAttributes.SESSION_ID, "42", ExecutionAttributes.MODEL_VISION, true)).build())
                    .messages(List.of(UserMessageEntity.from("inspect sample.bmp"))).build();
            Execution execution = Execution.builder().id("image-loop").agentId("test")
                    .agentRequest(request).messages(new ArrayList<>(request.getMessages())).tokenUsage(TokenUsageEntity.empty()).build();
            RuntimeBoundaryChecker budget = new RuntimeBoundaryChecker() {
                public CheckPointResult before(Execution current) {
                    return current.getModelAttempts() < 3 ? CheckPointResult.continueWith() : CheckPointResult.cancelWith("测试轮次超限");
                }
                public CheckPointResult after(Execution current) { return CheckPointResult.continueWith(); }
            };
            try (DefaultToolExecutionManager tools = new DefaultToolExecutionManager(
                    new ToolExecutionContext(events, new ToolRegistry(List.of(definition)), 4),
                    invocation -> ((ToolExecutor) invocation.getTarget()).execute(invocation.getContext()), List.of())) {
                RuntimeContext context = RuntimeContext.builder().conversationManager(new DefaultConversationManager(ContextAttachmentProvider.NONE))
                        .workspace(new LocalWorkspace("test", workspaceRoot.toString())).runtimeEventPublisher(events)
                        .toolExecutionManager(tools).runtimeBoundaryChecker(budget)
                        .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(
                                new DefaultLoopInterceptor(), new ImageInjectionInterceptor(cache))))
                        .invoker(new DefaultChatModelInvoker(model)).build();
                assertEquals(LoopResult.Status.COMPLETED, new AgentLoopStepRunner(context)
                        .run(execution, new ExecutionControlSignal(execution.getId())).status());
            }
            assertEquals(2, requests.size());
            assertEquals(ToolCatalog.READ_IMAGE, requests.getFirst().at("/tools/0/function/name").asText());
            JsonNode messages = requests.get(1).path("messages");
            assertEquals("assistant", messages.get(1).path("role").asText());
            assertEquals("tool", messages.get(2).path("role").asText());
            assertEquals("read-call", messages.get(2).path("tool_call_id").asText());
            assertEquals("user", messages.get(3).path("role").asText());
            String imageUrl = messages.get(3).at("/content/1/image_url/url").asText();
            assertTrue(imageUrl.startsWith("data:image/png;base64,"));
            byte[] pixels = Base64.getDecoder().decode(imageUrl.substring(imageUrl.indexOf(',') + 1));
            assertEquals(ImageFormat.PNG, ImageFormat.detect(pixels));
            JsonNode receipt = mapper.readTree(messages.get(2).path("content").asText());
            Path cached = cache.resolve(42L, receipt.at("/images/0/imageId").asText(), "png");
            assertEquals(Base64.getEncoder().encodeToString(Files.readAllBytes(cached)),
                    Base64.getEncoder().encodeToString(pixels));
        } finally {
            server.stop(0);
        }
    }
}
