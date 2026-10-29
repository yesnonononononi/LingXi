package com.summit.dp.model.api.dto;

import com.fasterxml.jackson.annotation.JsonAlias;

public record ModelConfigRequest(
        Long id,
        String modelName,
        String baseUrl,
        String apiKey,
        String provider,
        Boolean vision,
        Long providerConfigId,
        @JsonAlias("useProviderApiKey") Boolean useProvider
) {
}
