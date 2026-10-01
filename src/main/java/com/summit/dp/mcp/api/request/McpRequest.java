package com.summit.dp.mcp.api.request;

import lombok.Data;

import java.util.List;
import java.util.Map;

/**
 * Mcp 接口层入参。
 * <p>与 {@code McpCommand} 字段同名，Controller 用 {@code BeanUtils.copyProperties} 平移。</p>
 */
@Data
public class McpRequest {
    private Long id;
    private String name;
    private String transport;
    private String url;
    /** 请求头；值等于 {@code McpVO.MASKED_VALUE} 时表示保持库中原值不变 */
    private Map<String, String> headers;
    /** stdio 启动命令（argv 风格） */
    private List<String> command;
    /** stdio 环境变量；值等于 {@code McpVO.MASKED_VALUE} 时表示保持库中原值不变 */
    private Map<String, String> env;
    /** 服务描述，随提示词下发给模型；由业务用户填写 */
    private String description;
    /** 初始化超时，毫秒 */
    private Long initializationTimeout;
    /** 执行超时，毫秒 */
    private Long executionTimeout;
    private Integer maxOutput;
    private Integer status;
}
