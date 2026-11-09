package com.summit.dp.device.interfaces.ws;

import com.summit.dp.device.application.DeviceRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * transport=ws 的启动验证（真实 Servlet 容器）。
 *
 * <p>为什么非要用全上下文 + RANDOM_PORT：{@code ServletServerContainerFactoryBean} 需要一个真实的
 * {@link jakarta.servlet.ServletContext} 里挂着 {@code ServerContainer} 属性，mock 上下文里
 * 根本没有这个属性（实测：MOCK 环境和 ApplicationContextRunner 都会在 refresh 阶段失败）。
 * 用 mock 测这条路径，以及测出来的红，都只是环境限制，得不到任何关于真实启动的结论。</p>
 *
 * <p>数据目录落到 target/ 下而不是 .run/：构建产物目录随 clean 消失，
 * 不会在仓库里留下运行时残留。</p>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "lingxi.device.transport=ws",
        "lingxi.data.dir=D:/Code/LingXi/target/device-ws-test/data", "lingxi.skill.dir=",
        "lingxi.config.sandbox-security.directory=target/device-ws-test/security",
        "lingxi.config.user-configs.path=D:/Code/LingXi/target/device-ws-test/user-configs.json",
        "lingxi.config.mcp.path=D:/Code/LingXi/target/device-ws-test/mcp.json",
        "lingxi.config.model.path=D:/Code/LingXi/target/device-ws-test/models.json",
        "lingxi.config.personalization.path=D:/Code/LingXi/target/device-ws-test/personalization.json",
        "TAVILY_APIKEY=test-placeholder", "DEEPSEEK_APIKEY=test-placeholder"
})
class DeviceWsStartupTest {

    @Autowired
    private DeviceWebSocketConfig config;

    @Autowired
    private DeviceRegistry registry;

    @Autowired
    private ServletServerContainerFactoryBean container;

    @Test
    void ws模式下上下文正常启动且通道装配完整() {
        assertThat(config).isNotNull();

        // 关键断言：没有假设备时注册表应为空，等真实握手 —— 应用不该因为"没有设备"就起不来
        assertThat(registry.size()).isZero();
    }

    @Test
    void 帧缓冲确实被放大到512KB() {
        // Spring 默认 8KB，一次节点树观察轻松超限；这条断言防的是"忘了放大"在图上看不出来
        assertThat(container.getMaxTextMessageBufferSize()).isEqualTo(512 * 1024);
        assertThat(container.getMaxBinaryMessageBufferSize()).isEqualTo(512 * 1024);
    }
}
