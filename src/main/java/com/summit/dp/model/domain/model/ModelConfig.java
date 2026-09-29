package com.summit.dp.model.domain.model;


import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;

@AllArgsConstructor
@Getter
@NoArgsConstructor
public class ModelConfig {
    private Long id;
    private String baseUrl;
    private String apiKey;
    private String modelName;
    private String provider;

    public String getMaskedApiKey() {
        if (apiKey == null || apiKey.isEmpty()) return apiKey;
        int length = apiKey.codePointCount(0, apiKey.length());
        int visible = length / 5;
        int prefixEnd = apiKey.offsetByCodePoints(0, visible);
        int suffixStart = apiKey.offsetByCodePoints(0, length - visible);
        return apiKey.substring(0, prefixEnd) + "***" + apiKey.substring(suffixStart);
    }
    public void update(String modelName, String baseUrl, String apiKey) {
        this.modelName = modelName;
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }

}
