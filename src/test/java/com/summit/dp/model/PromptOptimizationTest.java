package com.summit.dp.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.ModelProvider;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.dp.model.Infrastructure.model.RegistryModelChatGateway;
import com.summit.dp.model.api.controller.PromptOptimizationController;
import com.summit.dp.model.application.service.ModelChatGateway;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.service.PromptOptimizationService;
import com.summit.dp.shared.config.GlobalExceptionHandler;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.sun.net.httpserver.HttpServer;
import openAi.DefaultChatModel;
import openAi.MessageSerializer;
import openAi.ModelChatResolver;
import openAi.RequestBodyFactory;
import openAi.ResponseSerializer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.ArgumentCaptor;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class PromptOptimizationTest {
    private final ModelService models = mock(ModelService.class);
    private final SettingsProvider settings = mock(SettingsProvider.class);
    private final ModelChatGateway gateway = mock(ModelChatGateway.class);
    private final PromptOptimizationService service = new PromptOptimizationService(models, settings, gateway);
    private final SettingsView current = new SettingsView(null, null, null, null, 7L, 99L, 258000, "medium", null, 10);

    @BeforeEach
    void configureModel() throws Exception {
        when(settings.current()).thenReturn(Optional.of(current));
        when(models.runtimeConfig(any(), eq(current))).thenReturn(ModelConfig.builder()
                .baseUrl("https://example.invalid/v1").apiKey("test-key").modelName("text-model").build());
        when(gateway.chat(any(), any(), any())).thenReturn(response("优化后的提示词"));
    }

    @Test
    void usesExplicitModelAndPassesOriginalPromptWithNoThinkingBudget() throws Exception {
        String original = "  先修复问题，再设计方案；Agent=123，team=456，禁止修改 D:/private。\n保留这些约束  ";
        assertEquals("优化后的提示词", service.optimize(original, 9007199254740993L));
        verify(models).runtimeConfig(9007199254740993L, current);
        ArgumentCaptor<ModelConfig> config = ArgumentCaptor.forClass(ModelConfig.class);
        ArgumentCaptor<String> systemPrompt = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(gateway).chat(config.capture(), systemPrompt.capture(), content.capture());
        assertEquals(Duration.ofSeconds(60), config.getValue().getTimeout());
        assertEquals(8192, config.getValue().getMaxTokens());
        assertFalse(config.getValue().isReturnThinking());
        assertFalse(config.getValue().isSendThinking());
        assertEquals(original, content.getValue());
        // 系统提示必须约束成"只输出正文"，否则模型会回答原文里的任务。
        assertTrue(systemPrompt.getValue().contains("仅输出优化后的提示词正文"));
    }

    @Test
    void fallsBackToConfiguredModelWithoutUsingTheDefaultAgent() {
        service.optimize("请优化原文", null);
        verify(models).runtimeConfig(7L, current);
    }

    @Test
    void invalidInputDoesNotInvokeAModel() {
        assertThrows(ClientException.class, () -> service.optimize(null, 7L));
        assertThrows(ClientException.class, () -> service.optimize(" \n ", 7L));
        assertThrows(ClientException.class, () -> service.optimize("x".repeat(20001), 7L));
        assertThrows(ClientException.class, () -> service.optimize("原文", 0L));
        verifyNoInteractions(models, gateway);
    }

    @Test
    void missingModelIsRejectedWithoutTouchingTheGateway() {
        when(settings.current()).thenReturn(Optional.empty());
        assertThrows(ClientException.class, () -> service.optimize("原文", null));
        verifyNoInteractions(gateway);
    }

    @ParameterizedTest
    @MethodSource("unusableResponses")
    void emptyToolCallingAndTruncatedResponsesAreRejected(ChatResponseEntity result) throws Exception {
        when(gateway.chat(any(), any(), any())).thenReturn(result);
        assertThrows(ClientException.class, () -> service.optimize("原文", 7L));
        verify(gateway, times(1)).chat(any(), any(), any());
    }

    static Stream<ChatResponseEntity> unusableResponses() {
        ChatResponseEntity tools = response("不要采用这段文本");
        tools.getAiMessageEntity().setToolCalls(List.of(new ToolCallRequest("call-1", "unexpected", 0, "{}")));
        ChatResponseEntity truncated = response("只有一半的优化结果");
        truncated.setMeta(ChatResponseEntity.Meta.builder().finishReason(ChatResponseEntity.FinishReason.LENGTH).build());
        return Stream.of(null, ChatResponseEntity.builder().build(), response(" \n "), tools, truncated);
    }

    @Test
    void endpointReturnsTextPreservesSnowflakeModelIdAndSanitizesProviderFailures() throws Exception {
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new PromptOptimizationController(service))
                .setControllerAdvice(new GlobalExceptionHandler()).build();
        mvc.perform(post("/model/optimize-prompt").contentType(APPLICATION_JSON)
                        .content("{\"prompt\":\"优化原文\",\"modelId\":\"9007199254740993\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(1))
                .andExpect(jsonPath("$.data").value("优化后的提示词"));
        verify(models).runtimeConfig(9007199254740993L, current);
        when(gateway.chat(any(), any(), any())).thenThrow(new IllegalStateException("provider-secret"));
        mvc.perform(post("/model/optimize-prompt").contentType(APPLICATION_JSON).content("{\"prompt\":\"原文\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.errMsg").value("提示词优化失败，请检查模型连接后重试"));
    }

    @Test
    void realProviderWireRequestContainsNoToolsOrToolChoice() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        AtomicReference<JsonNode> captured = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            captured.set(mapper.readTree(exchange.getRequestBody()));
            byte[] bytes = "{\"id\":\"test\",\"object\":\"chat.completion\",\"model\":\"text-model\",\"choices\":[{\"index\":0,\"message\":{\"role\":\"assistant\",\"content\":\"优化后的提示词\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5,\"total_tokens\":15}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        try {
            ModelConfig config = ModelConfig.builder().baseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/v1")
                    .apiKey("test-key").modelName("text-model").build();
            when(models.runtimeConfig(7L, current)).thenReturn(config);
            ModelProviderRegistry<ChatModel> chats = new ModelProviderRegistry<>();
            chats.register(openAiChatProvider());
            PromptOptimizationService wired = new PromptOptimizationService(models, settings,
                    new RegistryModelChatGateway(chats));
            assertEquals("优化后的提示词", wired.optimize("原始输入", 7L));
            JsonNode body = captured.get();
            assertNotNull(body);
            assertEquals(2, body.path("messages").size());
            assertEquals("user", body.path("messages").get(1).path("role").asText());
            assertEquals("原始输入", body.path("messages").get(1).path("content").asText());
            JsonNode canary = mapper.readTree("{\"tools\":[{}],\"tool_choice\":\"auto\"}");
            assertTrue(canary.has("tools") && canary.has("tool_choice"));
            assertFalse(body.has("tools"));
            assertFalse(body.has("tool_choice"));
        } finally {
            server.stop(0);
        }
    }

    private static ChatResponseEntity response(String text) {
        return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text(text).build()).build();
    }

    /**
     * 框架自带的 OpenAI 协议 chat provider。
     *
     * <p>旧实现是 {@code OpenAiChatModelProvider}（已随 LangChain4j 适配器退役）；
     * 现在生产环境注册进 {@code ModelProviderRegistry} 的是 harness-net 的 {@link DefaultChatModel}，
     * 这里直接构造同一实现，保证断言打到真实线上请求体。</p>
     */
    private static ModelProvider<ChatModel> openAiChatProvider() {
        return new ModelProvider<>() {
            @Override
            public String name() {
                return DefaultModelProviderNames.DEFAULT;
            }

            @Override
            public ChatModel create(ModelConfig config) {
                ObjectMapper mapper = new ObjectMapper();
                return new DefaultChatModel(config,
                        new ModelChatResolver(new RequestBodyFactory(new MessageSerializer(mapper), mapper), mapper, new ResponseSerializer()),
                        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build());
            }
        };
    }
}
