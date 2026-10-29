package com.summit.dp.model.domain.model;


import lombok.AllArgsConstructor;
import lombok.Getter;
import lombok.NoArgsConstructor;
import com.summit.dp.shared.exception.ClientException;

@AllArgsConstructor
@Getter
@NoArgsConstructor
public class ModelConfig {
    public static final int MODEL_NAME_MAX_LENGTH = 100;
    private Long id;
    private String baseUrl;
    private String apiKey;
    private String modelName;
    private String provider;
    /** 提供方删除后仍保留原标识，避免静默改变密钥来源。 */
    private Long providerConfigId;
    private boolean vision;
    private boolean useProvider;

    public ModelConfig(Long id, String baseUrl, String apiKey, String modelName, String provider,
                       Long providerConfigId, boolean vision) {
        this(id, baseUrl, apiKey, modelName, provider, providerConfigId, vision, false);
    }

    /** 兼容既有调用：未归属任何提供商预设。 */
    public ModelConfig(Long id, String baseUrl, String apiKey, String modelName, String provider, boolean vision) {
        this(id, baseUrl, apiKey, modelName, provider, null, vision);
    }

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

    public void changeUseProvider(boolean useProvider) {
        this.useProvider = useProvider;
    }

    /** {@code 0} 表示显式解除归属（归入「未分组」）；正数指向 provider_config.id。 */
    public void changeProviderConfigId(Long providerConfigId) {
        this.providerConfigId = providerConfigId == null || providerConfigId <= 0 ? null : providerConfigId;
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
