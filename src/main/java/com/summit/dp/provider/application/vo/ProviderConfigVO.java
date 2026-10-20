package com.summit.dp.provider.application.vo;

import lombok.Builder;
import lombok.Data;

/** 提供商配置视图：密钥只回掩码，明文不出接口。 */
@Builder
@Data
public class ProviderConfigVO {
    private Long id;
    private String name;
    private String icon;
    private String baseUrl;
    /** 前 20% + *** + 后 20% 的只读展示值 */
    private String apiKey;
    private Integer sortOrder;
    /** 库中是否已配置密钥；前端据此展示「已配置/未配置」 */
    private boolean credentialConfigured;
}
