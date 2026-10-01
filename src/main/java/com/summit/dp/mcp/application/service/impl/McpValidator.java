package com.summit.dp.mcp.application.service.impl;

import com.summit.dp.mcp.application.command.McpCommand;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.List;
import java.util.Map;

/**
 * Mcp 新增/更新的业务校验。
 *
 * <p>两类规则：<b>形态校验</b>（非空、长度、URL 可解析、超时为正）与
 * <b>唯一性校验</b>（服务名不与他人重复，重名查询下推到 SQL）。每个校验都以
 * 「返回错误文案 / 返回 null」表达，入口方法读成一张清单。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class McpValidator {

    private final McpRepository repository;

    /** 入参与库里的传输方式都是线上形态（streamable-http / sse / stdio），取值不受支持时统一给这条 */
    private static final String TRANSPORT_HINT = "传输方式仅支持 streamable-http / sse / stdio";

    /** @return null 表示校验通过，否则为错误提示 */
    public String validateForCreate(McpCommand command) {
        if (command == null) return "新增参数不能为空";
        if (command.getName() == null || command.getName().isBlank()) return "服务名称不能为空";

        Mcp.Transport transport = command.getTransport() == null
                ? Mcp.Transport.STREAMABLE_HTTP : transportOrNull(command.getTransport());
        String error = firstError(
                transport == null ? TRANSPORT_HINT : null,
                requiredByTransport(command, transport),
                checkShape(command));
        if (error != null) return error;

        return checkNameUnique(command.getName(), null);
    }

    /** @return null 表示校验通过，否则为错误提示 */
    public String validateForUpdate(McpCommand command) {
        if (command == null) return "更新参数不能为空";
        if (command.getId() == null) return "id不能为空";

        String error = firstError(
                // 更新允许部分字段缺省；缺省的字段由应用层保持原值，因此只校验显式传入的部分
                command.getName() != null && command.getName().isBlank() ? "服务名称不能为空" : null,
                checkShape(command));
        if (error != null) return error;

        return command.getName() == null ? null : checkNameUnique(command.getName(), command.getId());
    }

    /** 依序取第一条错误（null 表示全过）：让两个入口读成一张校验清单，而不是一串 error 变量 */
    private static String firstError(String... errors) {
        for (String error : errors) {
            if (error != null) return error;
        }
        return null;
    }

    /**
     * 新增是全字段操作：必填项按传输方式分派——stdio 要启动命令，http 系要服务地址。
     * <p>「切换传输后另一半参数缺失」的组合态由领域侧 {@code requireCoherent} 在落库前兜底。</p>
     */
    private String requiredByTransport(McpCommand command, Mcp.Transport transport) {
        if (transport == null) return null;
        if (transport == Mcp.Transport.STDIO) return checkCommand(command.getCommand());
        if (command.getUrl() == null || command.getUrl().isBlank()) return "服务地址不能为空";
        return null;
    }

    /**
     * 归一传输方式：入参可能写成线上形态（{@code streamable-http}）或枚举名（{@code STREAMABLE_HTTP}），
     * 统一交给领域枚举解析——与框架侧 {@code McpTransport.parse} 同一套规则，两端不各自定义合法写法。
     *
     * @return null 表示取值不受支持
     */
    private static Mcp.Transport transportOrNull(String transport) {
        try {
            return Mcp.Transport.parse(transport);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private String checkShape(McpCommand command) {
        if (command.getName() != null) {
            if (command.getName().trim().length() > Mcp.NAME_MAX_LENGTH)
                return "服务名称长度不能超过" + Mcp.NAME_MAX_LENGTH;
        }

        if (command.getUrl() != null) {
            String url = command.getUrl().trim();
            if (url.length() > Mcp.URL_MAX_LENGTH)
                return "服务地址长度不能超过" + Mcp.URL_MAX_LENGTH;
            if (!isHttpUrl(url)) return "服务地址必须是 http 或 https 开头的合法地址";
        }

        if (command.getTransport() != null && transportOrNull(command.getTransport()) == null) {
            return TRANSPORT_HINT;
        }

        if (command.getCommand() != null) {
            String error = checkCommand(command.getCommand());
            if (error != null) return error;
        }

        if (command.getEnv() != null) {
            String error = checkEnv(command.getEnv());
            if (error != null) return error;
        }

        if (command.getDescription() != null
                && command.getDescription().trim().length() > Mcp.DESCRIPTION_MAX_LENGTH)
            return "服务描述长度不能超过" + Mcp.DESCRIPTION_MAX_LENGTH;

        if (command.getInitializationTimeout() != null && command.getInitializationTimeout() <= 0)
            return "初始化超时必须大于 0";
        if (command.getExecutionTimeout() != null && command.getExecutionTimeout() <= 0)
            return "执行超时必须大于 0";
        if (command.getMaxOutput() != null && command.getMaxOutput() <= 0)
            return "输出上限必须大于 0";

        return checkHeaders(command.getHeaders());
    }

    /**
     * stdio 启动命令：argv 非空且每段非空白。
     * <p>argv 逐段传递不需要转义，允许段内出现空格（如带空格的路径）——这正是 argv 的意义。</p>
     */
    private String checkCommand(List<String> command) {
        if (command == null || command.isEmpty()) return "stdio 启动命令不能为空";
        if (command.size() > Mcp.COMMAND_MAX_ITEMS)
            return "启动命令段数不能超过" + Mcp.COMMAND_MAX_ITEMS;
        for (String argv : command) {
            if (argv == null || argv.isBlank()) return "启动命令包含空白段";
            if (argv.length() > Mcp.COMMAND_ARGV_MAX_LENGTH)
                return "启动命令单段长度不能超过" + Mcp.COMMAND_ARGV_MAX_LENGTH;
        }
        return null;
    }

    /** stdio 环境变量：键非空且不含等号/空白；值允许空串（如 {@code NO_COLOR=""}） */
    private String checkEnv(Map<String, String> env) {
        if (env.isEmpty()) return null;
        for (Map.Entry<String, String> entry : env.entrySet()) {
            if (entry.getKey() == null || entry.getKey().isBlank())
                return "环境变量名不能为空";
            if (entry.getKey().contains("=") || entry.getKey().contains(" "))
                return "环境变量名不合法: " + entry.getKey();
            if (entry.getValue() == null)
                return "环境变量 " + entry.getKey() + " 的值不能为 null";
        }
        return null;
    }

    /** 请求头名与值都不能为空白——空白字符放进 HTTP 头会直接让连接建不起来 */
    private String checkHeaders(Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() == null || entry.getKey().isBlank())
                return "请求头名称不能为空";
            if (entry.getKey().contains(" ") || entry.getKey().contains(":"))
                return "请求头名称不合法: " + entry.getKey();
            if (entry.getValue() == null || entry.getValue().isBlank())
                return "请求头 " + entry.getKey() + " 的值不能为空";
        }
        return null;
    }

    private boolean isHttpUrl(String url) {
        try {
            URI uri = URI.create(url);
            String scheme = uri.getScheme();
            return uri.getHost() != null
                    && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
        } catch (IllegalArgumentException e) {
            log.debug("URL 解析失败: {}", url, e);
            return false;
        }
    }

    /**
     * 服务名全局唯一。
     *
     * @param excludedId 更新场景下排除自身；新增传 null
     */
    private String checkNameUnique(String name, Long excludedId) {
        if (name == null || name.isBlank()) return null;
        return repository.findByName(name.trim())
                .filter(existing -> !existing.getId().equals(excludedId))
                .map(existing -> "服务名称已存在: " + existing.getName())
                .orElse(null);
    }
}
