package com.summit.dp.model.application.vo;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 提供商聚合分组：模型配置页与输入框上拉框共用同一份结构。
 *
 * <p>{@code providerConfigId} 为空的是「未分组」，包含未归属模型与预设已删除的悬空引用。</p>
 */
@Builder
@Data
public class ProviderModelGroupVO {
    private Long providerConfigId;
    private String providerName;
    private String providerIcon;
    private String baseUrl;
    private int modelCount;
    private List<ModelConfigVO> models;
}
