package com.summit.dp.model.application.vo;

import lombok.Builder;
import lombok.Data;

import java.time.Duration;
import java.util.List;

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
    /**
     * 该模型上真正可区分的思考档位（框架 {@code ReasoningEffortPlan} 裁决）。
     *
     * <p>Anthropic 上 xhigh 与 high 生成完全相同的请求，所以这里不包含它 —— 前端滑杆按这份集合渲染，
     * 不再由前端硬编码一份「所有模型都支持 6 档」的假设。</p>
     */
    private List<String> reasoningEfforts;
}
