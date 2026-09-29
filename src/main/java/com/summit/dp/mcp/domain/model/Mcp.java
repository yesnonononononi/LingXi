package com.summit.dp.mcp.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;

/**
 * Mcp 领域模型。
 *
 * <p>字段与框架侧 {@code com.summit.core.conf.McpConfig.MCP} 保持一致：本模块是<b>持久化侧</b>，
 * 框架侧是<b>消费侧</b>，装配时由 {@code McpConfigAssembler} 逐字段搬运到 {@code McpConfig.MCP}，
 * 因此字段语义（超时单位、prefix 语义、maxOutput 含义）以框架侧 record 为准，此处不另行解释。</p>
 *
 * <p>状态收敛为领域方法：{@link #changeEnabled(boolean)} 等，不由应用层直接赋值——
 * 变更时统一刷新 {@code updateAt}。</p>
 */
@Builder
@Getter
public class Mcp {

    /** 服务名上限：与框架侧日志/工具前缀可读性相关，此处仅作输入护栏 */
    public static final int NAME_MAX_LENGTH = 64;
    public static final int URL_MAX_LENGTH = 1024;
    public static final int TOOL_NAME_PREFIX_MAX_LENGTH = 64;

    /** 允许的传输方式；框架侧 {@code McpClientFactory} 按此值选择 builder */
    public static final String TRANSPORT_STREAMABLE_HTTP = "streamable-http";
    public static final String TRANSPORT_SSE = "sse";

    /** 超时缺省值，与框架侧缺省语义对齐 */
    public static final Duration DEFAULT_INITIALIZATION_TIMEOUT = Duration.ofSeconds(30);
    public static final Duration DEFAULT_EXECUTION_TIMEOUT = Duration.ofSeconds(60);
    public static final int DEFAULT_MAX_OUTPUT = 20000;

    /** 1 = 启用，0 = 停用；与库中 status 列一致 */
    public static final int STATUS_ENABLED = 1;
    public static final int STATUS_DISABLED = 0;

    private final Long id;

    /** 服务唯一名；请求级容器用它作为会话标识与工具前缀回落依据 */
    private String name;

    /** 传输方式，取值见 TRANSPORT_* 常量 */
    private String transport;

    /** 服务端点 */
    private String url;

    /**
     * 自定义请求头，如 {@code Authorization: Bearer xxx}。
     * <p>持久化为 JSON 字符串（PO 侧），领域侧始终是 Map，不暴露字符串形态。</p>
     */
    private Map<String, String> headers;

    /** 工具名前缀；为空时由框架侧回落为 {@code name + "_"} */
    private String toolNamePrefix;

    private Duration initializationTimeout;

    private Duration executionTimeout;

    /** 单次工具输出最大字符数 */
    private int maxOutput;

    private Integer status;

    private final Instant createAt;

    private Instant updateAt;

    public void changeName(String name) {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("Mcp name is blank");
        if (name.length() > NAME_MAX_LENGTH) throw new IllegalArgumentException("Mcp name is too long");
        this.name = name;
        update();
    }

    public void changeTransport(String transport) {
        if (transport == null || transport.isBlank()) throw new IllegalArgumentException("Mcp transport is blank");
        this.transport = transport;
        update();
    }

    public void changeUrl(String url) {
        if (url == null || url.isBlank()) throw new IllegalArgumentException("Mcp url is blank");
        if (url.length() > URL_MAX_LENGTH) throw new IllegalArgumentException("Mcp url is too long");
        this.url = url;
        update();
    }

    public void changeHeaders(Map<String, String> headers) {
        this.headers = headers == null ? Map.of() : Map.copyOf(headers);
        update();
    }

    public void changeToolNamePrefix(String toolNamePrefix) {
        if (toolNamePrefix != null && toolNamePrefix.length() > TOOL_NAME_PREFIX_MAX_LENGTH)
            throw new IllegalArgumentException("Mcp toolNamePrefix is too long");
        this.toolNamePrefix = toolNamePrefix;
        update();
    }

    public void changeInitializationTimeout(Duration initializationTimeout) {
        if (initializationTimeout == null || initializationTimeout.isNegative() || initializationTimeout.isZero())
            throw new IllegalArgumentException("Mcp initializationTimeout must be positive");
        this.initializationTimeout = initializationTimeout;
        update();
    }

    public void changeExecutionTimeout(Duration executionTimeout) {
        if (executionTimeout == null || executionTimeout.isNegative() || executionTimeout.isZero())
            throw new IllegalArgumentException("Mcp executionTimeout must be positive");
        this.executionTimeout = executionTimeout;
        update();
    }

    public void changeMaxOutput(int maxOutput) {
        if (maxOutput <= 0) throw new IllegalArgumentException("Mcp maxOutput must be positive");
        this.maxOutput = maxOutput;
        update();
    }

    public void changeEnabled(boolean enabled) {
        this.status = enabled ? STATUS_ENABLED : STATUS_DISABLED;
        update();
    }

    /** 该服务是否参与本轮请求级装配 */
    public boolean enabled() {
        return status != null && status == STATUS_ENABLED;
    }

    private void update() {
        this.updateAt = Instant.now();
    }
}
