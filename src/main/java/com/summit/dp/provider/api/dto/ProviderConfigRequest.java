package com.summit.dp.provider.api.dto;

public record ProviderConfigRequest(
        Long id,
        String name,
        String icon,
        String baseUrl,
        String apiKey,
        Integer sortOrder
) {
}
