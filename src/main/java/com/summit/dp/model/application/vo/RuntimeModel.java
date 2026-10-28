package com.summit.dp.model.application.vo;

import com.summit.core.conf.ModelConfig;
import com.summit.dp.user_configs.application.vo.SettingsView;

import java.time.Duration;

/** 连接参数与能力声明必须来自同一次配置读取，避免混用修改前后的模型。 */
public record RuntimeModel(ModelConfig config, boolean vision) {
    /**
     * 专用压缩模型的连接参数快照；{@code null} 表示沿用对话模型做摘要。
     *
     * <p>与 {@link ModelConfig.CompactModelConfig} 同形，但只在应用层内部流转，
     * 不把框架类型泄漏给调用方。</p>
     */
    public record CompactModel(String baseUrl, String apiKey, String modelName) {
    }

    public static RuntimeModel create(String baseUrl, String apiKey, String modelName, String provider,
                                      boolean vision, SettingsView settings, Duration timeout) {
        return create(baseUrl, apiKey, modelName, provider, vision, settings, timeout, null);
    }

    /**
     * @param compactModel 专用压缩模型；{@code null} 表示沿用对话模型
     */
    public static RuntimeModel create(String baseUrl, String apiKey, String modelName, String provider,
                                      boolean vision, SettingsView settings, Duration timeout,
                                      CompactModel compactModel) {
        ModelConfig.ModelConfigBuilder builder = ModelConfig.builder().baseUrl(baseUrl).apiKey(apiKey)
                .modelName(modelName).provider(provider).returnThinking(true).sendThinking(true)
                .reuseModelForCompaction(true)
                // 请求级配置会独立创建客户端，超时必须显式继承，避免落回 SDK 默认值。
                .timeout(timeout);
        if (settings != null) builder.maxTokens(settings.maxTokens()).reasoningEffort(settings.reasoningEffort());
        if (compactModel != null) {
            // 两个开关必须同进同退：只关 reuseModelForCompaction 而不给 compactModel，
            // 框架会退回「应用级 compact 配置」（yaml 里那套空 base-url），压缩直接失败。
            builder.reuseModelForCompaction(false)
                    .compactModel(new ModelConfig.CompactModelConfig(
                            compactModel.baseUrl(), compactModel.apiKey(), compactModel.modelName()));
        }
        return new RuntimeModel(builder.build(), vision);
    }
}
