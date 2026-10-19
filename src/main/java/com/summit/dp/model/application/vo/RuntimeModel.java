package com.summit.dp.model.application.vo;

import com.summit.core.conf.ModelConfig;
import com.summit.dp.user_configs.application.vo.SettingsView;

/** 连接参数与能力声明必须来自同一次配置读取，避免混用修改前后的模型。 */
public record RuntimeModel(ModelConfig config, boolean vision) {
    public static RuntimeModel create(String baseUrl, String apiKey, String modelName, String provider,
                                      boolean vision, SettingsView settings) {
        ModelConfig.ModelConfigBuilder builder = ModelConfig.builder().baseUrl(baseUrl).apiKey(apiKey)
                .modelName(modelName).provider(provider).returnThinking(true).sendThinking(true);
        if (settings != null) builder.maxTokens(settings.maxTokens()).reasoningEffort(settings.reasoningEffort());
        return new RuntimeModel(builder.build(), vision);
    }
}
