package com.summit.dp.model.application.command;

/**
 * 模型配置通用命令：新增(add)与更新(update)共用；更新时依据 id 定位记录。
 *
 * @param providerConfigId 归属的提供商预设；{@code null} 表示不修改，{@code 0} 表示解除归属
 * @param useProviderApiKey 是否用提供商预设里的密钥覆盖模型密钥；为 true 时忽略 apiKey
 */
public record  ModelConfigCommand (
        Long id,
        String modelName,
        String baseUrl,
        String apiKey,
        Boolean vision,
        Long providerConfigId,
        Boolean useProviderApiKey
){
    /** 兼容既有调用：不指定提供商归属。 */
    public ModelConfigCommand(Long id, String modelName, String baseUrl, String apiKey, Boolean vision) {
        this(id, modelName, baseUrl, apiKey, vision, null, null);
    }

    /** 兼容既有调用：指定归属但不复用提供商密钥。 */
    public ModelConfigCommand(Long id, String modelName, String baseUrl, String apiKey,
                              Boolean vision, Long providerConfigId) {
        this(id, modelName, baseUrl, apiKey, vision, providerConfigId, null);
    }
}
