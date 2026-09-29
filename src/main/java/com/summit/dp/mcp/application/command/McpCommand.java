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
    private String toolNamePrefix;
    /** 初始化超时，毫秒；null 表示走缺省 */
    private Long initializationTimeout;
    /** 执行超时，毫秒；null 表示走缺省 */
    private Long executionTimeout;
    private Integer maxOutput;
    private Integer status;
}
