package com.summit.dp.tools.baseTools.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

/**
 * 终端命令必须是纯串行：{@code execute_command} 一旦不再是 {@code SERIAL_MUTATION}，
 * 框架的 {@code DefaultToolExecutionManager#canExecuteConcurrently} 就会把整批命令放进并发窗口。
 *
 * <p>本用例是回退守卫 —— 把策略改回 READ_ONLY / ISOLATED_MUTATION（或留 null）都会让它变红。</p>
 */
class ExecuteCommandConcurrencyTest {

    private final ToolDefinition<CommandToolDefinitionExecutor> definition =
            new CommonToolConfiguration().executeCommandToolDefinition(new ObjectMapper());

    @Test
    @DisplayName("execute_command 声明 SERIAL_MUTATION，整批命令退化为串行执行")
    void commandToolIsSerial() {
        assertEquals(ConcurrentPolicy.SERIAL_MUTATION, definition.concurrentPolicy(),
                "终端工具必须串行：并发策略一旦改回可并发档位，同轮多条命令会并行抢占工作区");
        assertFalse(definition.allowConcurrent(),
                "allowConcurrent 为真时框架会走并发分支，模型同轮发出的命令不再顺序执行");
    }
}
