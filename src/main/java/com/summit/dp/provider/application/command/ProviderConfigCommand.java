package com.summit.dp.provider.application.command;

/**
 * 提供商配置命令：新增与更新共用。
 *
 * @param apiKey 三态：{@code null} 或空串保留原值、非空替换；回传掩码视为保留
 */
public record ProviderConfigCommand(
        Long id,
        String name,
        String icon,
        String baseUrl,
        String apiKey,
        Integer sortOrder
) {
}
