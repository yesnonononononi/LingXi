package com.summit.dp.model.api.dto;

public record ModelConfigRequest(
        Long id,
        String modelName,
        String baseUrl,
        String apiKey,
        String provider
) {
}
