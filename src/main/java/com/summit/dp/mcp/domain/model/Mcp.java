package com.summit.dp.mcp.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
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

    /** 允许的传输方式；框架侧按 {@code McpTransport.parse} 归一后分派 builder */
    public static final String TRANSPORT_STREAMABLE_HTTP = "streamable-http";
    public static final String TRANSPORT_SSE = "sse";
    public static final String TRANSPORT_STDIO = "stdio";

    /** stdio 启动命令护栏：argv 条数与单段长度上限 */
    public static final int COMMAND_MAX_ITEMS = 32;
    public static final int COMMAND_ARGV_MAX_LENGTH = 1024;

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

    /**
     * 服务端点（http 系传输）。
     * <p>stdio 传输下为 {@code null}——端点的角色由 {@link #command} 承担。</p>
     */
    private String url;

    /**
     * 自定义请求头，如 {@code Authorization: Bearer xxx}（http 系传输）。
     * <p>持久化为 JSON 字符串（PO 侧），领域侧始终是 Map，不暴露字符串形态。</p>
     */
    private Map<String, String> headers;

    /**
     * stdio 启动命令，argv 风格——如 {@code ["npx", "shadcn@latest", "mcp"]}。
     * <p>argv 逐段传递而非整行 shell，天然规避空格/引号转义问题；仅 stdio 传输使用。</p>
     */
    private List<String> command;

    /**
     * stdio 环境变量，叠加在继承的进程环境之上——如 {@code GITHUB_TOKEN}。
     * <p>常含凭据，视图层与 headers 同样脱敏。</p>
     */
    private Map<String, String> env;

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

    public void changeCommand(List<String> command) {
        if (command == null || command.isEmpty())
            throw new IllegalArgumentException("Mcp command is empty");
        if (command.size() > COMMAND_MAX_ITEMS)
            throw new IllegalArgumentException("Mcp command has too many items");
        for (String argv : command) {
            if (argv == null || argv.isBlank())
                throw new IllegalArgumentException("Mcp command contains blank argv");
            if (argv.length() > COMMAND_ARGV_MAX_LENGTH)
                throw new IllegalArgumentException("Mcp command argv is too long");
        }
        this.command = List.copyOf(command);
        update();
    }

    public void changeEnv(Map<String, String> env) {
        this.env = env == null ? Map.of() : Map.copyOf(env);
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

    /**
     * 传输方式与连接参数的整体一致性：http 系必须有 url，stdio 必须有 command。
     * <p>新增/更新落库前调用——单字段护栏（changeX）各自为政，拦不住「切换传输方式后
     * 另一半参数缺失」的组合态。</p>
     */
    public void requireCoherent() {
        if (TRANSPORT_STDIO.equals(transport)) {
            if (command == null || command.isEmpty())
                throw new IllegalArgumentException("Mcp stdio transport requires command");
        } else if (url == null || url.isBlank()) {
            throw new IllegalArgumentException("Mcp transport '" + transport + "' requires url");
        }
    }

    private void update() {
        this.updateAt = Instant.now();
    }
}
