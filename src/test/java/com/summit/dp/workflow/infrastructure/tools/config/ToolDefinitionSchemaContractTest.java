package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.adapter.langchain4j.codec.tool.ToolCodecAdapter;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import com.summit.dp.workflow.infrastructure.tools.config.properties.WebSearchToolProperties;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.ManageCommandToolExecutor;
import dev.langchain4j.agent.tool.ToolSpecification;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

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
                AnnotatedToolTestDefinitions.create(CommandToolDefinitionExecutor.class, new CommandToolDefinitionExecutor(objectMapper, null, null, new CommandToolProperties())),
                AnnotatedToolTestDefinitions.create(ManageCommandToolExecutor.class, new ManageCommandToolExecutor(objectMapper, null)),
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
    void executeCommandExposesOptionalShellWithoutChangingRequiredArguments() throws Exception {
        ToolDefinition<?> definition = AnnotatedToolTestDefinitions.create(CommandToolDefinitionExecutor.class, new CommandToolDefinitionExecutor(objectMapper, null, null, new CommandToolProperties()));

        JsonNode schema = objectMapper.readTree(definition.parametersJsonSchema());
        JsonNode required = schema.get("required");
        List<String> requiredNames = new ArrayList<>();
        required.forEach(property -> requiredNames.add(property.asText()));
        assertEquals(List.of("command", "intention"), requiredNames);

        List<String> properties = new ArrayList<>();
        schema.get("properties").fieldNames().forEachRemaining(properties::add);
        assertEquals(List.of("command", "shell", "intention", "background"), properties);

        JsonNode shell = schema.get("properties").get("shell");
        assertEquals("string", shell.path("type").asText());
        List<String> shellNames = new ArrayList<>();
        shell.path("enum").forEach(value -> shellNames.add(value.asText()));
        assertEquals(List.of("cmd", "pwsh", "powershell", "bash", "sh", "zsh"), shellNames);

        assertTrue(schema.get("properties").get("command").get("description").asText()
                .contains("does not detect script languages"));

        String description = definition.description();
        assertTrue(description.contains("Omit shell to use the workspace default"),
                "未指定 shell 时应说明使用工作区默认解释器");
        assertTrue(description.contains("Set shell to cmd, pwsh or powershell"),
                "工具描述应明确说明如何选择解释器");
        assertFalse(description.toLowerCase().contains("do not add a shell launcher prefix"),
                "旧的启动前缀禁令必须删除，否则模型不敢显式调用其它解释器");
        assertFalse(definition.parametersJsonSchema().toLowerCase().contains("do not add a shell launcher prefix"));
    }
}
