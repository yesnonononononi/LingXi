package com.summit.dp.mcp.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.Builder;
import lombok.Getter;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Mcp 领域模型。
 *
 * <p>字段与框架侧 {@code com.summit.core.conf.McpConfig.MCP} 保持一致：本模块是<b>持久化侧</b>，
 * 框架侧是<b>消费侧</b>，装配时由 {@code McpConfigAssembler} 逐字段搬运到 {@code McpConfig.MCP}，
 * 因此字段语义（超时单位、prefix 语义、maxOutput 含义）以框架侧 record 为准，此处不另行解释。</p>
 */
@Builder
@Getter
public class Mcp {

    public enum Transport {
        STREAMABLE_HTTP,
        SSE,
        STDIO;

        public static Transport parse(String value) {
            String normalized = value == null ? "" : value.trim().toUpperCase(Locale.ROOT).replace('-', '_');
            try {
                return Transport.valueOf(normalized);
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException("Unknown MCP transport: " + value, e);
            }
        }
    }

    /**
     * 服务名上限：与框架侧日志可读性相关，此处仅作输入护栏
     */
    public static final int NAME_MAX_LENGTH = 64;
    public static final int URL_MAX_LENGTH = 1024;

    /**
     * 服务描述上限：提示词里一个服务一行（名字 - 描述 - 工具数），过长会挤占上下文
     */
    public static final int DESCRIPTION_MAX_LENGTH = 200;

    /**
     * stdio 启动命令护栏：argv 条数与单段长度上限
     */
    public static final int COMMAND_MAX_ITEMS = 32;
    public static final int COMMAND_ARGV_MAX_LENGTH = 1024;

    /**
     * 超时缺省值，与框架侧缺省语义对齐
     */
    public static final Duration DEFAULT_INITIALIZATION_TIMEOUT = Duration.ofSeconds(30);
    public static final Duration DEFAULT_EXECUTION_TIMEOUT = Duration.ofSeconds(60);
    public static final int DEFAULT_MAX_OUTPUT = 20000;

    /**
     * 1 = 启用，0 = 停用；与库中 status 列一致
     */
    public static final int STATUS_ENABLED = 1;
    public static final int STATUS_DISABLED = 0;

    private final Long id;

    /**
     * 服务唯一名；请求级容器用它作为会话标识，也是模型按服务名查看工具清单的依据
     */
    private String name;

    /**
     * 服务描述：随提示词下发给模型（提示词里一个服务一行），用于让模型判断该服务是否相关。
     * <p>由业务用户填写——服务端 MCP 的 {@code instructions} 有不确定性，不作为来源。</p>
     */
    private String description;

    /**
     * 传输方式，取值见 {@link Transport}
     */
    private Transport transport;

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

    private Duration initializationTimeout;

    private Duration executionTimeout;

    /**
     * 单次工具输出最大字符数
     */
    private int maxOutput;

    private Integer status;

    private final Instant createAt;

    private Instant updateAt;

    public void changeName(String name) {
        throwEIf("Mcp name is blank", name == null || name.isBlank());
        throwEIf("Mcp name is too long", name.length() > NAME_MAX_LENGTH);
        this.name = name;
        update();
    }

    public void changeTransport(Transport transport) {
        throwEIf("Mcp transport is null", transport == null);
        this.transport = transport;
        update();
    }

    public void changeUrl(String url) {
        throwEIf("Mcp url is blank", url == null || url.isBlank());
        throwEIf("Mcp url is too long", url.length() > URL_MAX_LENGTH);
        this.url = url;
        update();
    }

    public void changeHeaders(Map<String, String> headers) {
        this.headers = headers == null ? Map.of() : Map.copyOf(headers);
        update();
    }

    public void changeCommand(List<String> command) {

        throwEIf("Mcp command is empty", command == null || command.isEmpty());
        throwEIf("Mcp command has too many items", command.size() > COMMAND_MAX_ITEMS);

        for (String argv : command) {
            throwEIf("Mcp command contains blank argv", argv == null || argv.isBlank());
            throwEIf("Mcp command argv is too long", argv.length() > COMMAND_ARGV_MAX_LENGTH);
        }
        this.command = List.copyOf(command);
        update();
    }

    public void changeEnv(Map<String, String> env) {
        this.env = env == null ? Map.of() : Map.copyOf(env);
        update();
    }

    public void changeDescription(String description) {
        throwEIf("Mcp description is too long",
                description != null && description.length() > DESCRIPTION_MAX_LENGTH);
        this.description = description;
        update();
    }

    public void changeInitializationTimeout(Duration initializationTimeout) {
        boolean condition = initializationTimeout == null || initializationTimeout.isNegative() || initializationTimeout.isZero();

        throwEIf("Mcp initializationTimeout must be positive", condition);
        this.initializationTimeout = initializationTimeout;
        update();
    }

    public void changeExecutionTimeout(Duration executionTimeout) {
        boolean condition = executionTimeout == null || executionTimeout.isNegative() || executionTimeout.isZero();
        throwEIf("Mcp executionTimeout must be positive", condition);
        this.executionTimeout = executionTimeout;
        update();
    }

    public void changeMaxOutput(int maxOutput) {
        throwEIf("Mcp maxOutput must be positive", maxOutput <= 0);
        this.maxOutput = maxOutput;
        update();
    }

    public void changeEnabled(boolean enabled) {
        this.status = enabled ? STATUS_ENABLED : STATUS_DISABLED;
        update();
    }

    /**
     * 该服务是否参与本轮请求级装配
     */
    public boolean enabled() {
        return status != null && status == STATUS_ENABLED;
    }

    /**
     * 传输方式与连接参数的整体一致性：http 系必须有 url，stdio 必须有 command。
     * <p>新增/更新落库前调用——单字段护栏（changeX）各自为政，拦不住「切换传输方式后
     * 另一半参数缺失」的组合态。</p>
     */
    public void requireCoherent() {
        if (transport == Transport.STDIO) {
            throwEIf("Mcp stdio transport requires command", command == null || command.isEmpty());
        } else if (url == null || url.isBlank()) {
            throwEIf("Mcp transport '" + transport + "' requires url", url == null || url.isBlank());
        }
    }

    private void update() {
        this.updateAt = Instant.now();
    }

    private void throwEIf(String err, boolean condition) {
        if (condition) throw new ClientException(err);
    }
}
