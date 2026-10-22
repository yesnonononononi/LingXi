package com.summit.dp.provider.api.dto;

/** 未保存时使用表单连接；已保存时允许仅传提供商标识。 */
public record ProviderModelsRequest(Long providerConfigId, String baseUrl, String apiKey) { }
