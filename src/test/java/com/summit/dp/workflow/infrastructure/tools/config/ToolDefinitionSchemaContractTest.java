package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.adapter.langchain4j.codec.tool.ToolCodecAdapter;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import com.summit.dp.workflow.infrastructure.tools.config.properties.WebSearchToolProperties;
import dev.langchain4j.agent.tool.ToolSpecification;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 工具定义里的 parametersJsonSchema 是模型请求的一部分，必须是合法 JSON 且能被 codec 转换。
 *
 * <p>这类错误编译期发现不了：Java 文本块同样处理转义序列，写成 {@code \"} 只会退化成裸引号，
 * 让 JSON 在运行时解析失败并阻断整批工具请求组装。所以用真实工具定义跑一次解析与转换。</p>
 */
class ToolDefinitionSchemaContractTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ToolCodecAdapter codec = new ToolCodecAdapter();
    private final CommonToolConfiguration configuration = new CommonToolConfiguration();

    private List<ToolDefinition<?>> allDefinitions() {
        return List.of(
                configuration.executeCommandToolDefinition(objectMapper, null, null, new CommandToolProperties()),
                configuration.manageCommandToolDefinition(objectMapper, null),
                configuration.webSearchToolDefinition(null, new WebSearchToolProperties(), objectMapper));
    }

    @Test
    void everyToolSchemaParsesAndConvertsToFrameworkTool() {
        for (ToolDefinition<?> definition : allDefinitions()) {
            assertDoesNotThrow(() -> objectMapper.readTree(definition.parametersJsonSchema()),
                    () -> "工具 " + definition.name() + " 的 parametersJsonSchema 不是合法 JSON");
            ToolSpecification specification = assertDoesNotThrow(() -> codec.toFrameworkTool(definition),
                    () -> "工具 " + definition.name() + " 无法转换为框架工具定义");
            assertEquals(definition.name(), specification.name());
        }
    }

    @Test
    void executeCommandKeepsSingleCommandParameterAndAllowsExplicitPowerShell() throws Exception {
        ToolDefinition<?> definition = configuration.executeCommandToolDefinition(
                objectMapper, null, null, new CommandToolProperties());

        JsonNode schema = objectMapper.readTree(definition.parametersJsonSchema());
        JsonNode required = schema.get("required");
        assertEquals("command", required.get(0).asText());
        assertEquals("intention", required.get(1).asText());
        List<String> properties = new ArrayList<>();
        schema.get("properties").fieldNames().forEachRemaining(properties::add);
        assertEquals(List.of("command", "intention", "background"), properties);
        assertTrue(schema.get("properties").get("command").get("description").asText()
                .contains("does not detect script languages"));

        String description = definition.description();
        assertTrue(description.contains("pwsh.exe -NoProfile -NonInteractive -Command"),
                "工具描述要给出显式启动 PowerShell 的示例");
        assertFalse(description.toLowerCase().contains("do not add a shell launcher prefix"),
                "旧的启动前缀禁令必须删除，否则模型不敢显式调用其它解释器");
        assertFalse(definition.parametersJsonSchema().toLowerCase().contains("do not add a shell launcher prefix"));
    }
}
