package com.summit.dp.agent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.ModelConfigVO;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.ModelRetryConfig;
import com.summit.core.agent.Execution;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.MockMvcPrint;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;

import java.net.InetSocketAddress;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import static org.awaitility.Awaitility.await;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

/** 配置保存、真实调用器、历史、实时快照和图片查询必须在同一轮闭环。 */
@SpringBootTest(properties = {"TAVILY_APIKEY=test-placeholder", "DEEPSEEK_APIKEY=test-placeholder", "lingxi.skill.dir="})
@AutoConfigureMockMvc(print = MockMvcPrint.NONE)
class ImageGenerationFlowTest {
    private static final Path ROOT = createRoot();
    private static final String DATABASE = H2TestDatabase.newDatasourceUrl("image-generation-v1");
    @Autowired private MockMvc mvc;
    @Autowired private ObjectMapper mapper;
    @MockitoSpyBean private ModelService models;
    @Autowired private SessionService sessions;
    @Autowired private ChatTurnRepository turns;
    @MockitoSpyBean private SseEventPublisher publisher;
    @MockitoSpyBean private LocalExecutionRepository checkpoints;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", () -> DATABASE);
        registry.add("spring.datasource.driver-class-name", () -> "org.h2.Driver");
        registry.add("lingxi.data.dir", () -> ROOT.resolve("data").toString());
        registry.add("lingxi.config.model.path", () -> ROOT.resolve("models.json").toString());
        registry.add("lingxi.config.provider.path", () -> ROOT.resolve("providers.json").toString());
        registry.add("lingxi.config.user-configs.path", () -> ROOT.resolve("settings.json").toString());
        registry.add("lingxi.config.mcp.path", () -> ROOT.resolve("mcp.json").toString());
        registry.add("lingxi.config.personalization.path", () -> ROOT.resolve("personalization.json").toString());
        registry.add("lingxi.config.sandbox-security.directory", () -> ROOT.resolve("security").toString());
    }

    @Test
    void explicitImageConfigurationCompletesAndRestoresAnImageOnlyReply() throws Exception {
        AtomicInteger requests = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/images/generations", exchange -> {
            requests.incrementAndGet();
            JsonNode request = mapper.readTree(exchange.getRequestBody());
            assertEquals("image-test", request.path("model").asText());
            String png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9V0AAAAASUVORK5CYII=";
            byte[] body = ("{\"created\":1,\"data\":[{\"b64_json\":\"" + png + "\"}],"
                    + "\"usage\":{\"input_tokens\":15,\"output_tokens\":80,\"total_tokens\":95,"
                    + "\"output_tokens_details\":{\"image_tokens\":80}}}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream output = exchange.getResponseBody()) { output.write(body); }
        });
        server.start();
        try {
            runFlow("http://127.0.0.1:" + server.getAddress().getPort() + "/v1", "local-test-key", "image-test", false);
            assertEquals(1, requests.get());
        } finally { server.stop(0); }
    }

    @Test
    @EnabledIfSystemProperty(named = "lingxi.image.live", matches = "true")
    void liveGatewayCompletesTheSameBusinessFlow() throws Exception {
        String key = System.getenv("LX_LIVE_IMAGE_KEY");
        assertNotNull(key, "真实验证需要通过进程环境传入一次性凭据");
        runFlow("https://globalai.vip/v1", key, "gpt-image-2.5-flare", true);
    }

    private void runFlow(String baseUrl, String key, String modelName, boolean live) throws Exception {
        doAnswer(invocation -> {
            Execution execution = invocation.getArgument(0);
            execution.getAgentRequest().setRetryConfig(ModelRetryConfig.builder().enabled(false).build());
            return invocation.callRealMethod();
        }).when(checkpoints).save(any());
        doAnswer(invocation -> {
            RuntimeModel model = (RuntimeModel) invocation.callRealMethod();
            // 真实验证只发一次计费请求，画质和重试不影响本次业务接线判据。
            model.config().setMaxRetries(0);
            model.config().setImageOptions(new ModelConfig.ImageOptions("low", "1024x1024", Map.of()));
            return model;
        }).when(models).resolveRuntimeConfig(anyLong(), any());
        List<JsonNode> frames = new CopyOnWriteArrayList<>();
        doAnswer(invocation -> {
            ObjectNode frame = mapper.valueToTree(invocation.getArgument(2));
            frame.put("type", invocation.<String>getArgument(1));
            frames.add(frame);
            return invocation.callRealMethod();
        }).when(publisher).publishBusiness(anyLong(), anyString(), any());
        ObjectNode config = mapper.createObjectNode().put("baseUrl", baseUrl).put("apiKey", key)
                .put("modelName", modelName).put("provider", "default-image-model").put("vision", false).put("useProvider", false);
        JsonNode saved = mapper.readTree(mvc.perform(post("/model/add").contentType("application/json")
                .content(mapper.writeValueAsBytes(config))).andReturn().getResponse().getContentAsString());
        assertEquals(1, saved.path("code").asInt(), "保存生图配置失败");
        ModelConfigVO model = models.catalog().getData().stream().flatMap(group -> group.getModels().stream())
                .filter(item -> modelName.equals(item.getModelName())).findFirst().orElseThrow();
        assertEquals("default-image-model", model.getProvider());
        long start = System.nanoTime();
        try {
            Long sessionId = sessions.initialize("生图端到端验证", null, null).getData();
            JsonNode accepted = mapper.readTree(mvc.perform(multipart("/a/completion/commands")
                    .param("sessionId", sessionId.toString()).param("modelId", model.getId().toString())
                    .param("input", "A small red wooden toy sailboat on calm blue water, white background, simple centered square composition, no text."))
                    .andReturn().getResponse().getContentAsString());
            assertEquals(1, accepted.path("code").asInt(), "生图请求未被受理");
            Long turnId = Long.valueOf(accepted.path("data").path("turnId").asText());
            await().atMost(Duration.ofMinutes(live ? 6 : 1)).until(() -> turns.findById(turnId)
                    .map(turn -> turn.getStatus().isTerminal()).orElse(false));
            ChatTurn turn = turns.findById(turnId).orElseThrow();
            assertEquals(ChatTurnStatus.COMPLETED, turn.getStatus(), "生图轮次失败：" + turn.getErrorReason());
            JsonNode history = mapper.readTree(mvc.perform(get("/session/{id}/messages", sessionId))
                    .andReturn().getResponse().getContentAsString()).path("data").path("turnViews").path(turnId.toString());
            JsonNode block = history.path("blocks").get(0);
            assertNotNull(block, "纯图片回复不能被当成空消息丢弃");
            assertEquals("", block.path("text").asText());
            assertTrue(block.path("isBody").asBoolean());
            String url = block.path("imageUrls").get(0).asText();
            byte[] image = mvc.perform(get(url)).andReturn().getResponse().getContentAsByteArray();
            assertTrue(image.length > 8);
            assertEquals((byte)0x89, image[0]);
            await().atMost(Duration.ofSeconds(5)).until(() -> frames.stream().anyMatch(frame ->
                    frame.path("type").asText().equals("TURN_SNAPSHOT") && frame.toString().contains(url)));
            if (!live) assertEquals(95L, turn.getTotalTokenCount());
            String export = System.getProperty("lingxi.image.output");
            if (live && export != null) {
                Path output = Path.of(export);
                Files.createDirectories(output);
                Files.write(output.resolve("generated.png"), image);
                ObjectNode report = mapper.createObjectNode().put("success", true).put("model", modelName)
                        .put("elapsedSeconds", (System.nanoTime() - start) / 1_000_000_000.0)
                        .put("inputTokens", turn.getInputTokenCount()).put("outputTokens", turn.getOutputTokenCount())
                        .put("totalTokens", turn.getTotalTokenCount()).put("imageBytes", image.length);
                report.set("history", history);
                report.set("frames", mapper.valueToTree(frames.stream().filter(frame -> frame.path("type").asText().equals("TURN_SNAPSHOT")).toList()));
                mapper.writerWithDefaultPrettyPrinter().writeValue(output.resolve("report.json").toFile(), report);
            }
        } finally { models.del(model.getId()); }
    }

    private static Path createRoot() {
        try { return Files.createTempDirectory("lingxi-image-v1-").toAbsolutePath().normalize(); }
        catch (IOException error) { throw new UncheckedIOException(error); }
    }

    @AfterAll
    static void cleanup() throws Exception {
        Path temp = Path.of(System.getProperty("java.io.tmpdir")).toAbsolutePath().normalize();
        assertTrue(ROOT.startsWith(temp) && ROOT.getFileName().toString().startsWith("lingxi-image-v1-"));
        try (Stream<Path> files = Files.walk(ROOT)) {
            for (Path file : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(file);
        }
    }
}
