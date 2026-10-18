package com.summit.dp.model;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.adapter.langchain4j.model.provider.OpenAiChatModelProvider;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.ModelChatCommand;
import com.summit.core.model.ModelInvoker;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.RequestModelInvokerFactory;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.model.streaming.StreamingChatModel;
import com.summit.dp.model.api.controller.PromptOptimizationController;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.service.PromptOptimizationService;
import com.summit.dp.shared.config.GlobalExceptionHandler;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.user_configs.application.vo.SettingsView;
import com.summit.runtime.model.DefaultRequestModelInvokerFactory;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.mockito.ArgumentCaptor;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.net.InetSocketAddress;
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
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class PromptOptimizationTest {
    private final ModelService models = mock(ModelService.class);
    private final SettingsProvider settings = mock(SettingsProvider.class);
    private final RequestModelInvokerFactory factory = mock(RequestModelInvokerFactory.class);
    private final ModelInvoker invoker = mock(ModelInvoker.class);
    private final PromptOptimizationService service = new PromptOptimizationService(models, settings, factory);
    private final SettingsView current = new SettingsView(null, null, null, null, 7L, 99L, 258000, "medium", null, 10);

    @BeforeEach
    void configureModel() throws Exception {
        when(settings.current()).thenReturn(Optional.of(current));
        when(models.runtimeConfig(any(), eq(current))).thenReturn(ModelConfig.builder()
                .baseUrl("https://example.invalid/v1").apiKey("test-key").modelName("text-model").build());
        when(factory.select(any(ModelConfig.class))).thenReturn(new RequestModelInvokerFactory.Selection("default", invoker, false));
        when(invoker.invoke(any())).thenReturn(response("优化后的提示词"));
    }

    @Test
    void usesExplicitModelAndOnlyTwoTextMessagesWithNoTools() throws Exception {
        String original = "  先修复问题，再设计方案；Agent=123，team=456，禁止修改 D:/private。\n保留这些约束  ";
        assertEquals("优化后的提示词", service.optimize(original, 9007199254740993L));
        verify(models).runtimeConfig(9007199254740993L, current);
        ArgumentCaptor<ModelConfig> config = ArgumentCaptor.forClass(ModelConfig.class);
        verify(factory).select(config.capture());
        assertEquals("default", config.getValue().getProvider());
        assertEquals(Duration.ofSeconds(60), config.getValue().getTimeout());
        assertEquals(8192, config.getValue().getMaxTokens());
        ArgumentCaptor<ModelChatCommand> command = ArgumentCaptor.forClass(ModelChatCommand.class);
        verify(invoker, times(1)).invoke(command.capture());
        ModelChatCommand call = command.getValue();
        assertFalse(call.streaming());
        assertFalse(call.thinking());
        assertEquals(List.of(), call.chatRequest().getTools());
        assertEquals(2, call.chatRequest().getMessages().size());
        assertInstanceOf(SystemMessageEntity.class, call.chatRequest().getMessages().getFirst());
        assertInstanceOf(UserMessageEntity.class, call.chatRequest().getMessages().getLast());
        assertEquals(original, call.chatRequest().getMessages().getLast().text());
    }

    @Test
    void fallsBackToConfiguredModelWithoutUsingTheDefaultAgent() {
        service.optimize("请优化原文", null);
        verify(models).runtimeConfig(7L, current);
    }

    @Test
    void resolvesAnthropicAndBuiltInStreamingConnectionsToSynchronousProviders() {
        when(models.runtimeConfig(7L, current)).thenReturn(ModelConfig.builder().modelName("claude-test").build());
        service.optimize("原文", 7L);
        when(models.runtimeConfig(7L, current)).thenReturn(ModelConfig.builder()
                .modelName("text-model").provider("default-streaming").build());
        service.optimize("原文", 7L);
        ArgumentCaptor<ModelConfig> config = ArgumentCaptor.forClass(ModelConfig.class);
        verify(factory, times(2)).select(config.capture());
        assertEquals(List.of("anthropic", "default"), config.getAllValues().stream().map(ModelConfig::getProvider).toList());
    }

    @Test
    void invalidInputDoesNotInvokeAModel() {
        assertThrows(ClientException.class, () -> service.optimize(null, 7L));
        assertThrows(ClientException.class, () -> service.optimize(" \n ", 7L));
        assertThrows(ClientException.class, () -> service.optimize("x".repeat(20001), 7L));
        assertThrows(ClientException.class, () -> service.optimize("原文", 0L));
        verifyNoInteractions(models, factory, invoker);
    }

    @Test
    void missingModelAndStreamingOnlyProviderAreRejected() {
        when(settings.current()).thenReturn(Optional.empty());
        assertThrows(ClientException.class, () -> service.optimize("原文", null));
        when(settings.current()).thenReturn(Optional.of(current));
        when(factory.select(any(ModelConfig.class))).thenReturn(new RequestModelInvokerFactory.Selection("custom", invoker, true));
        assertThrows(ClientException.class, () -> service.optimize("原文", 7L));
        verifyNoInteractions(invoker);
    }

    @ParameterizedTest
    @MethodSource("unusableResponses")
    void emptyToolCallingAndTruncatedResponsesAreRejected(ChatResponseEntity result) throws Exception {
        when(invoker.invoke(any())).thenReturn(result);
        assertThrows(ClientException.class, () -> service.optimize("原文", 7L));
        verify(invoker, times(1)).invoke(any());
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
        when(invoker.invoke(any())).thenThrow(new IllegalStateException("provider-secret"));
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
            chats.register(new OpenAiChatModelProvider());
            ModelProviderRegistry<StreamingChatModel> streams = new ModelProviderRegistry<>();
            PromptOptimizationService wired = new PromptOptimizationService(models, settings,
                    new DefaultRequestModelInvokerFactory("default", config, chats, streams));
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
}
