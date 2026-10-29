package com.summit.dp.mcp;

import com.summit.dp.mcp.application.command.McpCommand;
import com.summit.dp.mcp.application.service.impl.McpValidator;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * Mcp 新增 / 更新入口的形态校验（两条入口共用同一套规则）。
 *
 * <p>工具名前缀已退役：工具名 = 框架固定的 {@code mcp_} + 服务端原始工具名，服务名不再进入
 * 模型侧 {@code function.name}，所以「名字含点号」不再是错误——这里锚定它不被拒绝，
 * 并把服务描述的长度护栏钉住。</p>
 */
class McpValidatorTest {

    private McpRepository repository() {
        return mock(McpRepository.class);
    }

    @Test
    @DisplayName("名字只是标签：含点号、空格都不再影响工具名，放行")
    void createAcceptsAnyNameBecauseItNeverReachesToolNames() {
        assertNull(validator(repository()).validateForCreate(createCommand("github", null)));
        assertNull(validator(repository()).validateForCreate(createCommand("draw.io", null)));
        assertNull(validator(repository()).validateForCreate(createCommand("my server", null)));
    }

    @Test
    @DisplayName("描述可空；恰好等于上限也放行")
    void createAcceptsDescriptionUpToTheLimit() {
        assertNull(validator(repository()).validateForCreate(createCommand("github", null)));
        assertNull(validator(repository()).validateForCreate(
                createCommand("github", "x".repeat(Mcp.DESCRIPTION_MAX_LENGTH))));
    }

    @Test
    @DisplayName("描述超过上限被拒绝")
    void createRejectsOverlongDescription() {
        String error = validator(repository()).validateForCreate(
                createCommand("github", "x".repeat(Mcp.DESCRIPTION_MAX_LENGTH + 1)));

        assertTrue(error != null && error.contains("服务描述"),
                "应指出描述长度限制，实际: " + error);
    }

    @Test
    @DisplayName("更新只带状态：不动描述即放行（缺省字段保持库中原值）")
    void updateWithStatusOnlyPasses() {
        assertNull(validator(repository()).validateForUpdate(statusCommand(6L)));
    }

    @Test
    @DisplayName("更新带超长描述被拒绝")
    void updateRejectsOverlongDescription() {
        McpCommand command = statusCommand(6L);
        command.setDescription("x".repeat(Mcp.DESCRIPTION_MAX_LENGTH + 1));

        String error = validator(repository()).validateForUpdate(command);

        assertTrue(error != null && error.contains("服务描述"),
                "应指出描述长度限制，实际: " + error);
    }

    /* ---------------- 客户端容错参数（协议版本 / 健康检查间隔 / 重连间隔） ---------------- */

    @Test
    @DisplayName("协议版本形态为 yyyy-MM-dd，前后空格由应用层归一")
    void protocolVersionShapeIsGuarded() {
        McpCommand valid = createCommand("github", null);
        valid.setProtocolVersion("2025-11-25");
        assertNull(validator(repository()).validateForCreate(valid));

        McpCommand padded = createCommand("github", null);
        padded.setProtocolVersion("  2025-11-25  ");
        assertNull(validator(repository()).validateForCreate(padded));

        McpCommand malformed = createCommand("github", null);
        malformed.setProtocolVersion("abc");
        assertTrue(validator(repository()).validateForCreate(malformed).contains("格式"),
                "非法协议版本应被指出");

        McpCommand overlong = createCommand("github", null);
        overlong.setProtocolVersion("2025-11-25" + "x".repeat(23));
        assertTrue(validator(repository()).validateForCreate(overlong).contains("长度"),
                "超过 32 字符应报长度错误");

        // 恰好 32 字符：长度合法但形态不符，必须落到「格式」而不是「长度」
        McpCommand exactlyMax = createCommand("github", null);
        exactlyMax.setProtocolVersion("2025-11-25" + "x".repeat(22));
        assertTrue(validator(repository()).validateForCreate(exactlyMax).contains("格式"),
                "32 字符在长度上限内，错误应来自形态");

        // 空白视同「清空」，由应用层归一成 null，不算非法
        McpCommand blank = createCommand("github", null);
        blank.setProtocolVersion("   ");
        assertNull(validator(repository()).validateForCreate(blank));
    }

    @Test
    @DisplayName("健康检查间隔与重连间隔都不得小于 1 毫秒")
    void tuningIntervalsMustBeAtLeastOneMillisecond() {
        McpCommand zeroHealth = createCommand("github", null);
        zeroHealth.setHealthCheckInterval(0L);
        assertTrue(validator(repository()).validateForCreate(zeroHealth).contains("健康检查间隔"));

        McpCommand negativeHealth = createCommand("github", null);
        negativeHealth.setHealthCheckInterval(-1L);
        assertTrue(validator(repository()).validateForCreate(negativeHealth).contains("健康检查间隔"));

        McpCommand zeroReconnect = createCommand("github", null);
        zeroReconnect.setReconnectInterval(0L);
        assertTrue(validator(repository()).validateForCreate(zeroReconnect).contains("重连间隔"));

        // 恰好 1 毫秒是合法下界
        McpCommand oneMilli = createCommand("github", null);
        oneMilli.setHealthCheckInterval(1L);
        oneMilli.setReconnectInterval(1L);
        assertNull(validator(repository()).validateForCreate(oneMilli));
    }

    @Test
    @DisplayName("客户端容错参数全部缺省时校验放行（沿用客户端库默认）")
    void absentTuningIsValid() {
        McpCommand command = createCommand("github", null);
        command.setAutoHealthCheck(null);
        command.setHealthCheckInterval(null);
        command.setReconnectInterval(null);
        command.setProtocolVersion(null);

        assertNull(validator(repository()).validateForCreate(command));
    }

    /* ---------------- 夹具 ---------------- */

    private McpValidator validator(McpRepository repository) {
        return new McpValidator(repository);
    }

    private McpCommand createCommand(String name, String description) {
        McpCommand command = new McpCommand();
        command.setName(name);
        command.setUrl("https://example.com/mcp");
        command.setDescription(description);
        return command;
    }

    private McpCommand statusCommand(Long id) {
        McpCommand command = new McpCommand();
        command.setId(id);
        command.setStatus(Mcp.STATUS_DISABLED);
        return command;
    }
}
