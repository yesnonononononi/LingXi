package com.summit.dp.model;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatRequestEntity;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.ModelProvider;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.dp.model.Infrastructure.model.RegistryModelChatGateway;
import com.summit.dp.model.application.service.ModelChatGateway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/** 通用同步模型调用点：连接名归一化与无工具消息组装。 */
class ModelChatGatewayTest {

    private final List<ModelConfig> created = new ArrayList<>();
    private final AtomicReference<ChatRequestEntity> captured = new AtomicReference<>();
    private final ModelProviderRegistry<ChatModel> chats = new ModelProviderRegistry<>();
    private final ModelChatGateway gateway;

    ModelChatGatewayTest() {
        for (String name : List.of(DefaultModelProviderNames.DEFAULT, DefaultModelProviderNames.NET_CHAT,
                DefaultModelProviderNames.ANTHROPIC, DefaultModelProviderNames.DEFAULT_COMPACT)) {
            chats.register(new ModelProvider<>() {
                @Override
                public String name() {
                    return name;
                }

                @Override
                public ChatModel create(ModelConfig config) {
                    created.add(config);
                    return request -> {
                        captured.set(request);
                        return ChatResponseEntity.builder()
                                .aiMessageEntity(AiMessageEntity.builder().text("模型输出").build()).build();
                    };
                }
            });
        }
        this.gateway = new RegistryModelChatGateway(chats);
    }

    @ParameterizedTest
    @CsvSource({
            "default-streaming, default",
            "net-streaming, net-chat",
            "anthropic-streaming, anthropic",
            "default-compact, default-compact"
    })
    void streamingConnectionNamesResolveToSynchronousProviders(String provider, String expected) {
        gateway.resolve(ModelConfig.builder().provider(provider).modelName("text-model").build());
        assertEquals(expected, created.getLast().getProvider());
    }

    @Test
    void missingProviderIsInferredFromTheModelName() {
        gateway.resolve(ModelConfig.builder().modelName("claude-3-5-sonnet").build());
        assertEquals(DefaultModelProviderNames.ANTHROPIC, created.getLast().getProvider());
        gateway.resolve(ModelConfig.builder().modelName("gpt-4o").build());
        assertEquals(DefaultModelProviderNames.DEFAULT, created.getLast().getProvider());
    }

    @Test
    void sharedConfigurationIsNotMutatedByNormalization() {
        ModelConfig shared = ModelConfig.builder().provider("default-streaming").modelName("text-model").build();
        gateway.resolve(shared);
        assertEquals("default-streaming", shared.getProvider());
        assertEquals(DefaultModelProviderNames.DEFAULT, created.getLast().getProvider());
    }

    @Test
    void chatSendsOnlySystemAndUserMessagesWithoutTools() {
        ModelConfig config = ModelConfig.builder().provider("default").modelName("text-model").build();
        ChatResponseEntity response = gateway.chat(config, "系统提示", "用户内容");
        assertEquals("模型输出", response.getAiMessageEntity().text());
        ChatRequestEntity request = captured.get();
        assertEquals(List.of(), request.getTools());
        assertEquals(2, request.getMessages().size());
        assertInstanceOf(SystemMessageEntity.class, request.getMessages().getFirst());
        assertInstanceOf(UserMessageEntity.class, request.getMessages().getLast());
        assertEquals("系统提示", request.getMessages().getFirst().text());
        assertEquals("用户内容", request.getMessages().getLast().text());
    }
}
