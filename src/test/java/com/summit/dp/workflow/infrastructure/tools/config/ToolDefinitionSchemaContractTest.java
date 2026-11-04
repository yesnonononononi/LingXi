package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.OsType;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import com.summit.dp.workflow.infrastructure.tools.config.properties.WebSearchToolProperties;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandShell;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.ManageCommandToolExecutor;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 工具定义里的 parametersJsonSchema 就是模型请求的一部分，必须是合法 JSON 且是对象型 schema。
 *
 * <p>这类错误编译期发现不了：Java 文本块同样处理转义序列，写成 {@code \"} 只会退化成裸引号，
 * 让 JSON 在运行时解析失败并阻断整批工具请求组装。所以用真实工具定义跑一次解析。</p>
 *
 * <p>旧的 {@code ToolCodecAdapter} 已随 LangChain4j 适配器退役；模型请求直接读取
 * {@link ToolDefinition#parametersJsonSchema()} 与 {@link ToolDefinition#name()}，
 * 因此契约测试改为直接断言这份 JSON，不再经过中间层。</p>
 */
class ToolDefinitionSchemaContractTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final CommonToolConfiguration configuration = new CommonToolConfiguration();

    private List<ToolDefinition<?>> allDefinitions() {
        return List.of(
                AnnotatedToolTestDefinitions.create(CommandToolDefinitionExecutor.class, new CommandToolDefinitionExecutor(objectMapper, null, null, new CommandToolProperties())),
                AnnotatedToolTestDefinitions.create(ManageCommandToolExecutor.class, new ManageCommandToolExecutor(objectMapper, null)),
                configuration.webSearchToolDefinition(null, new WebSearchToolProperties(), objectMapper));
    }

    /** 每个工具都必须给出可解析的对象型 schema，且工具名与描述可直接进模型请求。 */
    @Test
    void everyToolSchemaParsesAsModelFacingJson() {
        for (ToolDefinition<?> definition : allDefinitions()) {
            JsonNode schema = assertDoesNotThrow(() -> objectMapper.readTree(definition.parametersJsonSchema()),
                    () -> "工具 " + definition.name() + " 的 parametersJsonSchema 不是合法 JSON");
            assertTrue(schema.isObject(), () -> "工具 " + definition.name() + " 的 parametersJsonSchema 必须是 JSON 对象");
            assertTrue(schema.path("properties").isObject(), () -> "工具 " + definition.name() + " 缺少 properties 对象");
            assertEquals("object", schema.path("type").asText(), () -> "工具 " + definition.name() + " 的 schema 类型必须是 object");
            assertFalse(definition.name() == null || definition.name().isBlank(), "工具名必须可用于模型请求");
            assertFalse(definition.description() == null || definition.description().isBlank(),
                    () -> "工具 " + definition.name() + " 缺少模型可见的描述");
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
        assertTrue(description.contains("If shell is omitted, the workspace default applies"),
                "未指定 shell 时应说明使用工作区默认解释器");
        assertTrue(description.contains("Set shell to cmd, pwsh or powershell"),
                "工具描述应明确说明如何选择解释器");
        assertFalse(description.toLowerCase().contains("do not add a shell launcher prefix"),
                "旧的启动前缀禁令必须删除，否则模型不敢显式调用其它解释器");
        assertFalse(definition.parametersJsonSchema().toLowerCase().contains("do not add a shell launcher prefix"));
    }

    @Test
    void modelFacingGuidanceRequiresShellSelectionForEveryIndependentCall() throws Exception {
        ToolDefinition<?> definition = AnnotatedToolTestDefinitions.create(CommandToolDefinitionExecutor.class, new CommandToolDefinitionExecutor(objectMapper));
        // 旧实现读 codec 转换后的 ToolSpecification.description()；新实现里模型看到的就是 definition.description()。
        String description = definition.description();
        assertTrue(description.contains("explicitly set shell on every call"));
        assertTrue(description.contains("including calls in the same batch"));
        assertTrue(description.contains("does not inherit shell selection or directory changes"));
        assertTrue(description.contains("; is not a CMD statement separator"));
        assertTrue(description.contains("JavaScript inside a quoted node -e argument does not select the outer shell"));
        assertTrue(description.contains("first check shell on the failing call"));

        JsonNode properties = objectMapper.readTree(definition.parametersJsonSchema()).get("properties");
        assertTrue(properties.get("shell").get("description").asText().contains("Explicitly set shell on every call"));
        assertTrue(properties.get("command").get("description").asText().contains("semicolons inside its quoted argument are not outer shell separators"));
    }

    @Test
    void modelFacingExamplesAreValidJsonAndSelectTheMatchingWindowsShell() throws Exception {
        ToolDefinition<?> definition = AnnotatedToolTestDefinitions.create(CommandToolDefinitionExecutor.class, new CommandToolDefinitionExecutor(objectMapper));
        Workspace workspace = mock(Workspace.class);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().osType(OsType.WINDOWS).shellType(ShellType.CMD).build());
        Matcher examples = Pattern.compile("```json\\n(.*?)\\n```", Pattern.DOTALL).matcher(definition.description());
        List<ShellType> shells = new ArrayList<>();
        while (examples.find()) {
            ExecuteCommandRequest request = objectMapper.readValue(examples.group(1), ExecuteCommandRequest.class);
            assertNotNull(request.getShell());
            assertFalse(request.getIntention().isBlank());
            ShellType shell = CommandShell.resolve(request, workspace);
            shells.add(shell);
            String prefix = shell == ShellType.PWSH ? "Set-Location -LiteralPath 'D:/repo';" : "cd /d \"D:/repo\" &&";
            assertTrue(request.getCommand().startsWith(prefix));
            assertTrue(request.getCommand().contains("node -e \"console.log(process.cwd())\""));
        }
        assertEquals(List.of(ShellType.PWSH, ShellType.CMD), shells);
    }
}
