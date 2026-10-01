package com.summit.dp.mcp.application.vo;

import lombok.Builder;
import lombok.Getter;

import java.util.List;
import java.util.Map;

/**
 * Mcp 视图对象。
 *
 * <p><b>关于 {@code headers} / {@code env}：</b>这两个字段常含凭据（令牌、API Key）。
 * 视图层返回的是<b>脱敏副本</b>（值替换为固定掩码），仅供前端展示「已配置哪些」；
 * 前端编辑时若未改动则原样回传脱敏值，由应用层识别掩码并保留库中原值——
 * 细节见 {@code McpServiceImpl}。</p>
 */
@Builder
@Getter
public class McpVO {

    /**
     * 凭据脱敏掩码（headers 与 env 通用）。
     * <p>应用层输出时把每个值替换为本常量，前端回传该值即表示「未改动」。</p>
     */
    public static final String MASKED_VALUE = "__MCP_HEADER_UNCHANGED__";

    private Long id;
    private String name;
    private String transport;
    /** http 系传输的端点；stdio 传输为 null */
    private String url;
    /** 脱敏后的请求头；掩码常量见 McpVO.MASKED_VALUE */
    private Map<String, String> headers;
    /** stdio 启动命令（argv 风格）；仅 stdio 传输非空 */
    private List<String> command;
    /** 脱敏后的 stdio 环境变量；仅 stdio 传输非空 */
    private Map<String, String> env;
    /** 服务描述，随提示词下发给模型；由业务用户填写 */
    private String description;
    private Long initializationTimeout;
    private Long executionTimeout;
    private Integer maxOutput;
    private Integer status;
}
