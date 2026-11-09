package com.summit.dp.device.interfaces.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.device.application.DeviceRegistry;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.infrastructure.ws.DevicePayloadMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;
import org.springframework.web.util.UriComponentsBuilder;

import java.util.Map;

/**
 * WSS 通道装配。仅在 {@code lingxi.device.transport=ws} 时生效。
 *
 * <p>用条件装配而不是"两个通道都注册"：多台设备同时在线时 {@code DeviceRegistry.anyOnline()}
 * 会返回空（刻意不猜），工具调用直接失败。要么明确走假设备，要么明确走真链路。</p>
 */
@Slf4j
@Configuration(proxyBeanMethods = false)
@EnableWebSocket
@EnableConfigurationProperties(DeviceWsProperties.class)
@ConditionalOnProperty(name = "lingxi.device.transport", havingValue = "ws")
public class DeviceWebSocketConfig implements WebSocketConfigurer {

    /**
     * 单帧文本上限。Spring 默认 8KB，而一次观察的节点树轻松超过它，真机上会直接抛
     * "The decoded text message was too big for the output buffer"——一个只在真机出现、
     * 本地假设备永远测不到的故障。
     */
    private static final int MAX_TEXT_BUFFER = 512 * 1024;

    private final DeviceWsProperties properties;
    private final ObjectMapper objectMapper;
    private final DevicePayloadMapper payloadMapper;
    private final DeviceRegistry registry;
    private final DeviceToolService deviceToolService;

    public DeviceWebSocketConfig(DeviceWsProperties properties,
                                 ObjectMapper objectMapper,
                                 DeviceRegistry registry,
                                 DeviceToolService deviceToolService) {
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.payloadMapper = new DevicePayloadMapper(objectMapper);
        this.registry = registry;
        this.deviceToolService = deviceToolService;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry handlerRegistry) {
        // 就地创建：本类既是配置类又是 WebSocketConfigurer，构造期注入本类定义的 Bean 会成环；
        // 就地创建也保证「注册表里的设备」与「handler 手里的设备」是同一份
        DeviceWebSocketHandler handler = new DeviceWebSocketHandler(
                objectMapper, payloadMapper, properties, registry, deviceToolService);
        handlerRegistry.addHandler(handler, properties.getPath())
                .addInterceptors(tokenInterceptor())
                // Android 原生客户端不发 Origin，这里放开来源限制；真正的访问控制靠
                // ①监听地址绑定内网 ②可选 token。放开 Origin 不等于放开鉴权。
                .setAllowedOriginPatterns("*");
        log.info("设备 WSS 通道已注册: path={}, tokenRequired={}", properties.getPath(), properties.requiresToken());
    }

    /** 放大帧缓冲，并让空闲连接不被容器提前掐断（心跳由协议层负责）。 */
    @Bean
    @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
    public ServletServerContainerFactoryBean deviceWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(MAX_TEXT_BUFFER);
        container.setMaxBinaryMessageBufferSize(MAX_TEXT_BUFFER);
        container.setMaxSessionIdleTimeout(properties.getHeartbeat().toMillis() * 6);
        return container;
    }

    private HandshakeInterceptor tokenInterceptor() {
        return new HandshakeInterceptor() {
            @Override
            public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                           WebSocketHandler wsHandler, Map<String, Object> attributes) {
                if (!properties.requiresToken()) {
                    return true;
                }
                String provided = UriComponentsBuilder.fromUri(request.getURI())
                        .build().getQueryParams().getFirst("token");
                boolean ok = properties.getToken().equals(provided);
                if (!ok) {
                    log.warn("设备接入被拒：token 不匹配，远程={}", request.getRemoteAddress());
                }
                return ok;
            }

            @Override
            public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                       WebSocketHandler wsHandler, Exception exception) {
                // 无需处理
            }
        };
    }
}
