package com.summit.dp.model.application.vo;

import com.summit.core.conf.ModelConfig;
import com.summit.dp.user_configs.application.vo.SettingsView;

import java.time.Duration;

/** 连接参数与能力声明必须来自同一次配置读取，避免混用修改前后的模型。 */
public record RuntimeModel(ModelConfig config, boolean vision) {
    public static RuntimeModel create(String baseUrl, String apiKey, String modelName, String provider,
                                      boolean vision, SettingsView settings, Duration timeout) {
        ModelConfig.ModelConfigBuilder builder = ModelConfig.builder().baseUrl(baseUrl).apiKey(apiKey)
                .modelName(modelName).provider(provider).returnThinking(true).sendThinking(true)
                // 请求级配置会独立创建客户端，超时必须显式继承，避免落回 SDK 默认值。
                .timeout(timeout);
        if (settings != null) builder.maxTokens(settings.maxTokens()).reasoningEffort(settings.reasoningEffort());
        return new RuntimeModel(builder.build(), vision);
    }
}
