package com.summit.dp.model.domain.model;


import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import com.summit.dp.shared.exception.ClientException;

@AllArgsConstructor
@Getter
@NoArgsConstructor
public class ModelConfig {
    private Long id;
    private String baseUrl;
    private String apiKey;
    private String modelName;
    private String provider;
    private boolean vision;

    public void changeModelName(String modelName) {
        throwIf(modelName == null || modelName.isBlank(), "模型名称不能为空");
        this.modelName = modelName.trim();
    }

    public void changeBaseUrl(String baseUrl) {
        throwIf(baseUrl == null || baseUrl.isBlank(), "模型 API Base URL 不能为空");
        this.baseUrl = baseUrl.trim();
    }

    public void changeApiKey(String apiKey) {
        this.apiKey = apiKey;
    }

    public void changeVision(boolean vision) {
        this.vision = vision;
    }

    public String getMaskedApiKey() {
        if (apiKey == null || apiKey.isEmpty()) return apiKey;
        int length = apiKey.codePointCount(0, apiKey.length());
        int visible = length / 5;
        int prefixEnd = apiKey.offsetByCodePoints(0, visible);
        int suffixStart = apiKey.offsetByCodePoints(0, length - visible);
        return apiKey.substring(0, prefixEnd) + "***" + apiKey.substring(suffixStart);
    }
    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

}
