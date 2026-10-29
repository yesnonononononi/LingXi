package com.summit.dp.mcp.application.command;

import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * Mcp 应用层命令。
 * <p>超时用毫秒传递，与接口层入参形态一致；转 {@link java.time.Duration} 由应用层统一完成。</p>
 */
@Data
public class McpCommand {
    private Long id;
    private String name;
    private String transport;
    /** http 系传输的端点；stdio 传输可不传 */
    private String url;
    /** 请求头；值等于 {@code McpVO.MASKED_VALUE} 时表示保持库中原值不变 */
    private Map<String, String> headers;
    /** stdio 启动命令（argv 风格） */
    private List<String> command;
    /** stdio 环境变量；值等于 {@code McpVO.MASKED_VALUE} 时表示保持库中原值不变 */
    private Map<String, String> env;
    /** 服务描述，随提示词下发给模型；由业务用户填写 */
    private String description;
    /** 初始化超时，毫秒；null 表示走缺省 */
    private Long initializationTimeout;
    /** 执行超时，毫秒；null 表示走缺省 */
    private Long executionTimeout;
    /** 显式协议版本，如 {@code 2025-11-25}；null 表示不钉版本（走客户端库协议探测） */
    private String protocolVersion;
    /** 自动健康检查开关；null 表示沿用客户端库默认 */
    private Boolean autoHealthCheck;
    /** 健康检查间隔，毫秒；null 表示沿用客户端库默认 */
    private Long healthCheckInterval;
    /** 重连间隔，毫秒；null 表示沿用客户端库默认 */
    private Long reconnectInterval;
    private Integer maxOutput;
    private Integer status;
}
