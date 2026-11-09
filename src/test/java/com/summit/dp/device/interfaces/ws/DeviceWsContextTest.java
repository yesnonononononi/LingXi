package com.summit.dp.device.interfaces.ws;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.device.application.DeviceRegistry;
import com.summit.dp.device.application.DeviceToolService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 配置切换的装配验证。
 *
 * <p>为什么要单独测：fake 模式下注册表里有一台假设备，ws 模式下注册表为空、等真实握手。
 * 两条路径的 bean 依赖关系不同；只测了 fake（默认）就宣布"没破坏启动"，等于没测
 * 用户真正要用的那条路。</p>
 *
 * <p>用 {@link ApplicationContextRunner} 而不是 @SpringBootTest：只装设备通道这一小块，
 * 秒级完成，也避免为了验证一个条件装配去拉起整条外部依赖。</p>
 */
class DeviceWsContextTest {

    private final WebApplicationContextRunner runner = new WebApplicationContextRunner()
            .withUserConfiguration(DeviceWebSocketConfig.class)
            .withBean(ObjectMapper.class, ObjectMapper::new)
            .withBean(DeviceRegistry.class, DeviceRegistry::new)
            .withBean(DeviceToolService.class, () -> mock(DeviceToolService.class));

    /**
     * 注意：{@code transport=ws} 的装配验证放在 {@link DeviceWsStartupTest}（真实 Servlet 容器）。
     * 这里用 mock 上下文跑不了 —— {@code ServletServerContainerFactoryBean} 需要真实的
     * {@code ServerContainer} 属性，mock 里没有，测出来的红只是环境限制，不是产品缺陷。
     */
    @Test
    void 默认transport为fake时通道配置不生效() {
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            // 默认不该注册 WSS 端点：一个总是打开的操控入口不是「方便」，是风险
            assertThat(context).doesNotHaveBean(DeviceWebSocketConfig.class);
        });
    }

    @Test
    void 非法transport取值当场失败而不是静默降级() {
        // 这条防的是最恶劣的一类失败：transport 拼错时条件装配不匹配，配置类压根不加载，
        // 于是应用正常启动、设备通道永久不工作，而日志里一句提示都没有。
        // 修法是把 DeviceWsProperties 注册到「始终加载」的 DeviceToolConfiguration 上，
        // 属性绑定一定发生，setter 校验就一定被触发。
        new ApplicationContextRunner()
                .withUserConfiguration(BindOnly.class)
                .withPropertyValues("lingxi.device.transport=websocket")
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void 合法transport取值能正常绑定() {
        new ApplicationContextRunner()
                .withUserConfiguration(BindOnly.class)
                .withPropertyValues("lingxi.device.transport=ws")
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(DeviceWsProperties.class).getTransport()).isEqualTo("ws");
                });
    }

    @Test
    void token可选但配置后必须校验() {
        DeviceWsProperties properties = new DeviceWsProperties();
        assertThat(properties.requiresToken()).isFalse();

        properties.setToken("s3cret");
        assertThat(properties.requiresToken()).isTrue();
        assertThat(properties.getToken()).isEqualTo("s3cret");
    }

    @Test
    void 超时配置拒绝非正数() {
        DeviceWsProperties properties = new DeviceWsProperties();
        org.junit.jupiter.api.Assertions.assertThrows(RuntimeException.class,
                () -> properties.setObserveTimeout(java.time.Duration.ZERO));
    }

    /** 只做属性绑定，模拟「始终加载」的那一侧，验证非法值不会被静默接受。 */
    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(DeviceWsProperties.class)
    static class BindOnly {
    }
}
