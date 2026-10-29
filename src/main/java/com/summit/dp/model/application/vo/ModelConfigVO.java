package com.summit.dp.model.application.vo;

import lombok.Builder;
import lombok.Data;

import java.time.Duration;

@Builder
@Data
public class ModelConfigVO {
    Long id;
    private String baseUrl;
    private String apiKey;
    private String modelName;
    private String provider;
    /** 所属提供商预设 ID；空=未分组 */
    private Long providerConfigId;
    /** 聚合自 provider_config 的展示名/图标，列表与下拉按它分组 */
    private String providerName;
    private String providerIcon;
    private boolean vision;
    private boolean useProvider;
    private Duration timeout;
    private boolean returnThinking;
    private boolean sendThinking;
    /** 当前选定的密钥来源是否已配置。 */
    private boolean credentialConfigured;
}
