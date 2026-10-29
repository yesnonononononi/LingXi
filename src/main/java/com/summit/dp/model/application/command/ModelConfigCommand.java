package com.summit.dp.model.application.command;

/**
 * 模型配置通用命令：新增(add)与更新(update)共用；更新时依据 id 定位记录。
 *
 * @param providerConfigId 归属的提供商预设；{@code null} 表示不修改，{@code 0} 表示解除归属
 * @param useProvider 是否实时使用提供方密钥；新增归属模型默认开启，更新不传则保留
 */
public record  ModelConfigCommand (
        Long id,
        String modelName,
        String baseUrl,
        String apiKey,
        Boolean vision,
        Long providerConfigId,
        Boolean useProvider
){
    /** 兼容既有调用：不指定提供商归属。 */
    public ModelConfigCommand(Long id, String modelName, String baseUrl, String apiKey, Boolean vision) {
        this(id, modelName, baseUrl, apiKey, vision, null, null);
    }

    /** 兼容既有调用：指定归属，密钥来源由新增或更新入口决定。 */
    public ModelConfigCommand(Long id, String modelName, String baseUrl, String apiKey,
                              Boolean vision, Long providerConfigId) {
        this(id, modelName, baseUrl, apiKey, vision, providerConfigId, null);
    }
}
