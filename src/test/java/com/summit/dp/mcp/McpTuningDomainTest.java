package com.summit.dp.mcp;

import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 领域模型对四个客户端容错字段的护栏（契约 §2.3）。
 *
 * <p>这些参数决定「客户端库要不要自己做协议探测 / 多久做一次健康检查」，
 * 取值非法会让服务连不上或刷屏，所以在领域层就拦住，而不是等装配到框架侧才报错。</p>
 *
 * <p>同时锚定 {@code changeX} 必须刷新 {@code updateAt}：它是「配置何时被改过」的唯一痕迹，
 * 少了它，界面上「最近更新」会一直停在旧时间。</p>
 */
class McpTuningDomainTest {

    private static final Instant OLD_UPDATE = Instant.parse("2020-01-01T00:00:00Z");

    /** 每次变更都从「很久以前更新过」的模型开始，这样 updateAt 是否前进一目了然。 */
    private Mcp model() {
        return Mcp.builder()
                .id(1L)
                .name("github")
                .transport(Mcp.Transport.STREAMABLE_HTTP)
                .url("https://api.githubcopilot.com/mcp/")
                .createAt(OLD_UPDATE)
                .updateAt(OLD_UPDATE)
                .build();
    }

    @Test
    @DisplayName("协议版本：合法值原样落位并 trim，null/空白归一为 null")
    void protocolVersionAcceptsValidValueAndNormalizesBlank() {
        Mcp model = model();
        model.changeProtocolVersion(" 2025-11-25 ");
        assertEquals("2025-11-25", model.getProtocolVersion());
        assertTrue(model.getUpdateAt().isAfter(OLD_UPDATE), "changeX 必须刷新 updateAt");

        Mcp blank = model();
        blank.changeProtocolVersion("   ");
        assertNull(blank.getProtocolVersion(), "空白等价于清空");

        Mcp absent = model();
        absent.changeProtocolVersion(null);
        assertNull(absent.getProtocolVersion());
        assertTrue(absent.getUpdateAt().isAfter(OLD_UPDATE), "清空同样是一次变更");
    }

    @Test
    @DisplayName("协议版本：形态不符与超长分别被拒")
    void protocolVersionRejectsMalformedAndOverlongValues() {
        Mcp model = model();

        ClientException malformed = assertThrows(ClientException.class,
                () -> model.changeProtocolVersion("abc"));
        assertTrue(malformed.getMessage().contains("2025-11-25"),
                "形态错误应指出期望形态: " + malformed.getMessage());

        // 恰好 32 字符：长度合法、形态不合法 → 必须报形态错误
        ClientException exactlyMax = assertThrows(ClientException.class,
                () -> model.changeProtocolVersion("2025-11-25" + "x".repeat(22)));
        assertTrue(exactlyMax.getMessage().contains("2025-11-25"),
                "32 字符在长度上限内，错误应来自形态: " + exactlyMax.getMessage());

        // 33 字符：先撞长度上限
        ClientException tooLong = assertThrows(ClientException.class,
                () -> model.changeProtocolVersion("2025-11-25" + "x".repeat(23)));
        assertTrue(tooLong.getMessage().contains("too long"),
                "超长应报长度错误: " + tooLong.getMessage());

        assertNull(model.getProtocolVersion(), "被拒的变更不得落位");
    }

    @Test
    @DisplayName("自动健康检查：三态都接受，含 null")
    void autoHealthCheckKeepsAllThreeStates() {
        Mcp model = model();
        model.changeAutoHealthCheck(Boolean.TRUE);
        assertEquals(Boolean.TRUE, model.getAutoHealthCheck());
        assertTrue(model.getUpdateAt().isAfter(OLD_UPDATE));

        model.changeAutoHealthCheck(Boolean.FALSE);
        assertEquals(Boolean.FALSE, model.getAutoHealthCheck());

        model.changeAutoHealthCheck(null);
        assertNull(model.getAutoHealthCheck(), "null 表示沿用客户端库默认，必须能写回");
    }

    @Test
    @DisplayName("健康检查间隔：1ms 是合法下界，0 与负数被拒，null 放行")
    void healthCheckIntervalGuard() {
        Mcp model = model();
        model.changeHealthCheckInterval(Duration.ofMillis(1));
        assertEquals(Duration.ofMillis(1), model.getHealthCheckInterval());
        assertTrue(model.getUpdateAt().isAfter(OLD_UPDATE));

        assertThrows(ClientException.class, () -> model.changeHealthCheckInterval(Duration.ZERO),
                "0 毫秒不是合法间隔");
        assertEquals(Duration.ofMillis(1), model.getHealthCheckInterval(), "被拒的变更不得落位");

        assertThrows(ClientException.class, () -> model.changeHealthCheckInterval(Duration.ofMillis(-1)));

        model.changeHealthCheckInterval(null);
        assertNull(model.getHealthCheckInterval(), "null 表示沿用客户端库默认，必须能写回");
    }

    @Test
    @DisplayName("重连间隔：1ms 是合法下界，0 与负数被拒，null 放行")
    void reconnectIntervalGuard() {
        Mcp model = model();
        model.changeReconnectInterval(Duration.ofMillis(1));
        assertEquals(Duration.ofMillis(1), model.getReconnectInterval());
        assertTrue(model.getUpdateAt().isAfter(OLD_UPDATE));

        assertThrows(ClientException.class, () -> model.changeReconnectInterval(Duration.ZERO),
                "0 毫秒不是合法间隔");
        assertEquals(Duration.ofMillis(1), model.getReconnectInterval(), "被拒的变更不得落位");

        assertThrows(ClientException.class, () -> model.changeReconnectInterval(Duration.ofMillis(-1)));

        model.changeReconnectInterval(null);
        assertNull(model.getReconnectInterval(), "null 表示沿用客户端库默认，必须能写回");
    }
}
