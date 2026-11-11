package com.summit.dp.model.Infrastructure.model;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatRequestEntity;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.DefaultModelProviderNames;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.ModelProviderRouting;
import com.summit.core.model.chat.ChatModel;
import com.summit.dp.model.application.service.ModelChatGateway;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 从框架的 chat provider 注册表造同步模型。
 *
 * <p>流式连接名必须在这里归一化：注册表按名字索引，chat 通道里没有 {@code *-streaming}
 * 这些名字，不换名会落到流式通道被误判成「不支持同步调用」，而底层本来就在同一实现上。</p>
 */
@Component
@RequiredArgsConstructor
public class RegistryModelChatGateway implements ModelChatGateway {

    /** 流式连接名到同步连接名的映射，与框架 provider 注册名保持一致。 */
    private static final Map<String, String> SYNC_PROVIDERS = Map.of(
            DefaultModelProviderNames.DEFAULT_STREAMING, DefaultModelProviderNames.DEFAULT,
            DefaultModelProviderNames.NET_STREAMING, DefaultModelProviderNames.NET_CHAT,
            DefaultModelProviderNames.ANTHROPIC_STREAMING, DefaultModelProviderNames.ANTHROPIC);

    private final ModelProviderRegistry<ChatModel> chatModels;

    @Override
    public ChatModel resolve(ModelConfig config) {
        // 调用方可能传共享配置（如 compact 模型配置），复制后再改 provider。
        String provider = toSyncProvider(config.getProvider(), config.getModelName());
        return chatModels.create(config.toBuilder().provider(provider).build());
    }

    @Override
    public ChatResponseEntity chat(ModelConfig config, String systemPrompt, String content) {
        ChatRequestEntity request = ChatRequestEntity.builder()
                .messages(List.of(
                        SystemMessageEntity.builder().text(systemPrompt).build(),
                        UserMessageEntity.from(content)))
                .tools(List.of())
                .build();
        return resolve(config).chat(request);
    }

    /** 显式 provider 优先，缺失时按模型名推断协议，再把流式名换成同步名。 */
    private static String toSyncProvider(String provider, String modelName) {
        String resolved = ModelProviderRouting.chatProvider(provider, modelName, false);
        return SYNC_PROVIDERS.getOrDefault(resolved, resolved);
    }
}
