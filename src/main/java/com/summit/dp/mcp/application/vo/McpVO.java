package com.summit.dp.mcp.application.vo;

import lombok.Builder;
import lombok.Getter;

import java.util.Map;

/**
 * Mcp 视图对象。
 *
 * <p><b>关于 {@code headers}：</b>该字段常含 {@code Authorization: Bearer ...} 这类凭据。
 * 视图层返回的是<b>脱敏副本</b>（值替换为固定掩码），仅供前端展示「已配置哪些头」；
 * 前端编辑时若未改动则原样回传脱敏值，由应用层识别掩码并保留库中原值——
 * 细节见 {@code McpServiceImpl}。</p>
 */
@Builder
@Getter
public class McpVO {

    /**
     * 请求头脱敏掩码。
     * <p>应用层输出时把每个头的值替换为本常量，前端回传该值即表示「未改动」。</p>
     */
    public static final String MASKED_VALUE = "__MCP_HEADER_UNCHANGED__";

    private Long id;
    private String name;
    private String transport;
    private String url;
    /** 脱敏后的请求头；掩码常量见 McpVO.MASKED_VALUE */
    private Map<String, String> headers;
    private String toolNamePrefix;
    private Long initializationTimeout;
    private Long executionTimeout;
    private Integer maxOutput;
    private Integer status;
}
