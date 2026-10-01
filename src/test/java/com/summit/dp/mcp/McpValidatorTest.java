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
