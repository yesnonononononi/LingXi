package com.summit.dp.model.Infrastructure.config;

import com.summit.core.conf.ModelConfig;
import com.summit.core.conf.SensitiveDataProvider;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.runtime.compact.RequestCompactModelResolver;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 压缩输出预算与设置页同源，不能继承对话模型的输出上限。 */
@Configuration(proxyBeanMethods = false)
public class CompactionModelConfiguration {

    @Bean
    public RequestCompactModelResolver requestCompactModelResolver(
            @Qualifier("chatModelConfig") ModelConfig applicationConfig,
            ObjectProvider<SensitiveDataProvider<ModelConfig>> configurations,
            ModelProviderRegistry<ChatModel> providers,
            @Qualifier("defaultContextCompactModel") ChatModel applicationCompactModel,
            CompactionProperties properties) {
        SensitiveDataProvider<ModelConfig> source = configurations.getIfAvailable();
        // 只改压缩解析器读到的副本，不能污染冻结版本或影响同轮对话的预算。
        SensitiveDataProvider<ModelConfig> compactConfigurations = source == null ? null : (id, version) -> {
            ModelConfig config = source.get(id, version);
            return config == null ? null : config.toBuilder().maxTokens(properties.getCompactMaxTokens()).build();
        };
        ModelConfig compactApplicationConfig = applicationConfig.toBuilder()
                .maxTokens(properties.getCompactMaxTokens()).build();
        return new RequestCompactModelResolver(compactApplicationConfig, compactConfigurations,
                providers, applicationCompactModel);
    }
}
