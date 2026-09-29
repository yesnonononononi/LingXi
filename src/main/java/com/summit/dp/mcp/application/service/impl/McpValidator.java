package com.summit.dp.mcp.application.service.impl;

import com.summit.dp.mcp.application.command.McpCommand;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.util.Map;

/**
 * Mcp 新增/更新的业务校验。
 *
 * <p>校验分两类：<b>形态校验</b>（非空、长度、URL 可解析、超时为正）与
 * <b>唯一性校验</b>（服务名不与他人重复）。重名查询下推到 SQL。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class McpValidator {

    private final McpRepository repository;

    /** @return null 表示校验通过，否则为错误提示 */
    public String validateForCreate(McpCommand command) {
        if (command == null) return "新增参数不能为空";

        String error = checkRequired(command.getName(), command.getTransport(), command.getUrl());
        if (error != null) return error;

        error = checkShape(command);
        if (error != null) return error;

        return checkNameUnique(command.getName(), null);
    }

    /** @return null 表示校验通过，否则为错误提示 */
    public String validateForUpdate(McpCommand command) {
        if (command == null) return "更新参数不能为空";
        if (command.getId() == null) return "id不能为空";

        // 更新允许部分字段缺省；缺省的字段由应用层保持原值，因此只校验显式传入的部分
        if (command.getName() != null || command.getTransport() != null || command.getUrl() != null) {
            String error = checkRequired(
                    command.getName() == null ? "-" : command.getName(),
                    command.getTransport() == null ? "-" : command.getTransport(),
                    command.getUrl() == null ? "-" : command.getUrl());
            if (error != null) return error;
        }

        String error = checkShape(command);
        if (error != null) return error;

        if (command.getName() != null) {
            return checkNameUnique(command.getName(), command.getId());
        }
        return null;
    }

    private String checkRequired(String name, String transport, String url) {
        if (name == null || name.isBlank()) return "服务名称不能为空";
        if (transport == null || transport.isBlank()) return "传输方式不能为空";
        if (url == null || url.isBlank()) return "服务地址不能为空";
        return null;
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

        if (command.getTransport() != null) {
            String transport = command.getTransport().trim().toLowerCase();
            if (!Mcp.TRANSPORT_STREAMABLE_HTTP.equals(transport) && !Mcp.TRANSPORT_SSE.equals(transport))
                return "传输方式仅支持 " + Mcp.TRANSPORT_STREAMABLE_HTTP + " 或 " + Mcp.TRANSPORT_SSE;
        }

        if (command.getToolNamePrefix() != null
                && command.getToolNamePrefix().length() > Mcp.TOOL_NAME_PREFIX_MAX_LENGTH)
            return "工具名前缀长度不能超过" + Mcp.TOOL_NAME_PREFIX_MAX_LENGTH;

        if (command.getInitializationTimeout() != null && command.getInitializationTimeout() <= 0)
            return "初始化超时必须大于 0";
        if (command.getExecutionTimeout() != null && command.getExecutionTimeout() <= 0)
            return "执行超时必须大于 0";
        if (command.getMaxOutput() != null && command.getMaxOutput() <= 0)
            return "输出上限必须大于 0";

        return checkHeaders(command.getHeaders());
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
