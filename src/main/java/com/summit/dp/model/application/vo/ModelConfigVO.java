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
    private Duration timeout;
    private boolean returnThinking;
    private boolean sendThinking;
    /** 数据库 API Key 是否已配置；前端据此展示「已配置/未配置」。 */
    private boolean credentialConfigured;
}
