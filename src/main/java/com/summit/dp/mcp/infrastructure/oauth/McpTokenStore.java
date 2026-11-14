package com.summit.dp.mcp.infrastructure.oauth;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 运行时凭据存储，按服务名保存在 {@code mcp-auth.json}。
 *
 * <p>刻意不写进 {@code mcp.json}：那是用户配置，会被拷贝进 issue、会被整文件重写触发连接重建；
 * 而令牌还会随刷新反复变化。两者生命周期不同，就该分开。</p>
 */
@Slf4j
@Component
public class McpTokenStore {

    /** 一个服务当前持有的令牌；{@code expiresAtMillis} 用毫秒而非 Instant，避免依赖 Jackson 时间模块的配置 */
    public record StoredToken(String accessToken, String refreshToken, long expiresAtMillis, String scope,
                              String clientId, String tokenEndpoint, String resource) {

        /** @return 是否已在 {@code skewMillis} 的安全边界内，边界内视为过期 */
        public boolean isExpiring(long skewMillis) {
            return expiresAtMillis <= System.currentTimeMillis() + skewMillis;
        }
    }

    private final ObjectMapper json;
    private final Path file;
    private final Map<String, StoredToken> tokens = new ConcurrentHashMap<>();
    private volatile boolean loaded;

    public McpTokenStore(ObjectMapper json,
                         @Value("${lingxi.config.mcp.auth-path:${user.home}/.lingxi/config/mcp-auth.json}") String path) {
        this.json = json;
        this.file = Path.of(path);
    }

    /** @return 该服务当前保存的令牌；文件损坏或缺失时为空 */
    public Optional<StoredToken> find(String serverName) {
        loadOnce();
        return Optional.ofNullable(tokens.get(serverName));
    }

    public void save(String serverName, StoredToken token) {
        loadOnce();
        tokens.put(serverName, token);
        persist();
    }

    public void remove(String serverName) {
        loadOnce();
        if (tokens.remove(serverName) != null) {
            persist();
        }
    }

    /** 首次访问才读盘：没人用到 OAuth 服务时不该碰这个文件 */
    private void loadOnce() {
        if (loaded) {
            return;
        }
        synchronized (this) {
            if (loaded) {
                return;
            }
            if (Files.exists(file)) {
                try {
                    Map<String, StoredToken> stored = json.readValue(Files.readAllBytes(file),
                            new TypeReference<Map<String, StoredToken>>() {
                            });
                    if (stored != null) {
                        tokens.putAll(stored);
                    }
                } catch (Exception failure) {
                    // 损坏的令牌文件等价于「还没授权」：让用户重新授权，比让服务起不来好
                    log.warn("MCP 凭据文件无法解析，按未授权处理: path={}", file, failure);
                }
            }
            loaded = true;
        }
    }

    /** 先写临时文件再原子替换：刷新与读取并发时不能读到半截文件 */
    private synchronized void persist() {
        try {
            Files.createDirectories(file.getParent());
            Map<String, StoredToken> snapshot = new LinkedHashMap<>(tokens);
            Path temp = Files.createTempFile(file.getParent(), "mcp-auth", ".tmp");
            Files.write(temp, json.writerWithDefaultPrettyPrinter().writeValueAsBytes(snapshot));
            Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException failure) {
            log.warn("MCP 凭据写入失败: path={}", file, failure);
        }
    }
}
