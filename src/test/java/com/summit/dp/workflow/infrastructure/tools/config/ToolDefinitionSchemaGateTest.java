package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.harness.springbootautoconfigure.toolHelper.ToolRegister;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.annotation.AnnotationAwareOrderComparator;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 启动期 Schema 门禁自身的回归：它必须真的会拦，而不是一个永远通过的空函数。
 *
 * <p>反例直接复刻本次线上缺陷——文本块里的转义引号退化成裸引号，JSON 里出现未转义的引号。</p>
 */
class ToolDefinitionSchemaGateTest {

    private final ToolDefinitionSchemaGate gate = new ToolDefinitionSchemaGate(null, new ObjectMapper());

    @Test
    void validSchemaPasses() {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        definitions.put("executeCommandToolDefinition",
                definition("execute_command", "{\"type\":\"object\",\"properties\":{\"command\":{\"type\":\"string\"}}}"));
        assertTrue(gate.check(definitions).isEmpty());
    }

    @Test
    void unescapedQuoteInsideSchemaIsRejectedAndNamesTheTool() {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        definitions.put("executeCommandToolDefinition", definition("execute_command",
                "{\"type\":\"object\",\"properties\":{\"command\":{\"description\":\"pwsh.exe -Command \"Get-ChildItem\"\"}}}"));

        IllegalStateException error = assertThrows(IllegalStateException.class, () -> gate.check(definitions));
        assertTrue(error.getMessage().contains("execute_command"), "报错必须点名工具: " + error.getMessage());
        assertTrue(error.getMessage().contains("executeCommandToolDefinition"), "报错必须点名 bean: " + error.getMessage());
    }

    @Test
    void missingSchemaIsRejected() {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        definitions.put("noSchemaTool", definition("no_schema", "  "));
        IllegalStateException error = assertThrows(IllegalStateException.class, () -> gate.check(definitions));
        assertTrue(error.getMessage().contains("没有参数 Schema"), error.getMessage());
    }

    @Test
    void schemaThatIsNotAJsonObjectIsRejected() {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        definitions.put("arraySchemaTool", definition("array_schema", "[]"));
        IllegalStateException error = assertThrows(IllegalStateException.class, () -> gate.check(definitions));
        assertTrue(error.getMessage().contains("不是 JSON 对象"), error.getMessage());
    }

    @Test
    void nullDefinitionIsRejected() {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        definitions.put("ghostTool", null);
        assertThrows(IllegalStateException.class, () -> gate.check(definitions));
    }

    @Test
    void validAndInvalidAreReportedTogether() {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        definitions.put("good", definition("good", "{\"type\":\"object\"}"));
        definitions.put("bad", definition("bad", "{\"type\":\"object\",}"));
        IllegalStateException error = assertThrows(IllegalStateException.class, () -> gate.check(definitions));
        assertEquals(1, error.getMessage().split("bad（bean: bad）", -1).length - 1);
    }

    @Test
    void runnerChecksRegistryEntriesWithoutDefinitionBeans() {
        ToolRegistry registry = new ToolRegistry(List.of());
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
            context.registerBean(ToolRegistry.class, () -> registry);
            context.refresh();
            ToolDefinitionSchemaGate registryGate = new ToolDefinitionSchemaGate(context, new ObjectMapper());
            assertTrue(context.getBeansOfType(ToolDefinition.class).isEmpty());
            registry.register(definition("registered_without_bean", "[]"));

            IllegalStateException error = assertThrows(IllegalStateException.class,
                    () -> registryGate.run(new DefaultApplicationArguments()));

            assertTrue(error.getMessage().contains("registered_without_bean"));
        }
    }

    @Test
    void annotationRegistrationMustRunBeforeTheRegistryGate() {
        ToolRegister registrar = new ToolRegister(new ToolRegistry(List.of()), new ObjectMapper(), null);

        assertTrue(AnnotationAwareOrderComparator.INSTANCE.compare(registrar, gate) < 0);
    }

    private ToolDefinition<?> definition(String name, String schema) {
        ToolExecutor executor = (ToolExecution execution) -> null;
        return ToolDefinition.builder()
                .maxOutput(1_000).timeout(10L)
                .executor(executor)
                .id(name).name(name)
                .description("schema gate fixture")
                .parametersJsonSchema(schema)
                .build();
    }
}
