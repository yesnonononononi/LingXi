package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.checklist.domain.model.ChecklistRules;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import com.summit.dp.workflow.infrastructure.tools.config.ToolDefinitionSchemaGate;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * 四个清单工具必须过真实的 Schema 门禁，并且带上「与 create_plan 的边界」说明。
 *
 * <p>门禁本体在这里是同一个实现（不是测试里另写的近似），所以它一旦被改成永远通过，
 * 这几条用例仍是绿的——但其它故意写坏的用例会红（见 {@code ToolDefinitionSchemaGateTest}）。</p>
 */
class ChecklistToolSchemaTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ToolDefinitionSchemaGate gate = new ToolDefinitionSchemaGate(null, objectMapper);

    @Test
    @DisplayName("四个工具一起过门禁：参数 Schema 都是合法 JSON 对象")
    void allFourChecklistToolsPassTheRealSchemaGate() throws Exception {
        Map<String, ToolDefinition<?>> definitions = new LinkedHashMap<>();
        definitions.put("createChecklistTool", definition(CreateChecklistTool.class));
        definitions.put("updateChecklistStepTool", definition(UpdateChecklistStepTool.class));
        definitions.put("modifyChecklistTool", definition(ModifyChecklistTool.class));
        definitions.put("deleteChecklistTool", definition(DeleteChecklistTool.class));

        assertEquals(List.of(), gate.check(definitions));
        for (ToolDefinition<?> definition : definitions.values()) {
            JsonNode schema = objectMapper.readTree(definition.parametersJsonSchema());
            assertEquals("object", schema.path("type").asText(), definition.name() + " 根节点必须是 object");
            assertFalse(schema.path("additionalProperties").asBoolean(true),
                    definition.name() + " 必须显式关闭 additionalProperties");
        }
    }

    @Test
    @DisplayName("create_checklist 的步骤数组上下限与领域常量同源")
    void createChecklistSchemaBindsStepBoundsToDomainConstants() throws Exception {
        JsonNode schema = schemaOf(CreateChecklistTool.class);
        JsonNode steps = schema.path("properties").path("steps");

        assertEquals("array", steps.path("type").asText());
        assertEquals(ChecklistRules.MIN_STEPS, steps.path("minItems").asInt());
        assertEquals(ChecklistRules.MAX_STEPS, steps.path("maxItems").asInt());
        assertEquals(List.of("title", "steps"), requiredOf(schema));
    }

    @Test
    @DisplayName("update_checklist_step 的状态只允许三个终态取值")
    void updateStepSchemaLimitsStatusToTerminalValues() throws Exception {
        JsonNode status = schemaOf(UpdateChecklistStepTool.class).path("properties").path("status");

        assertEquals("string", status.path("type").asText());
        List<String> enums = new java.util.ArrayList<>();
        status.path("enum").forEach(node -> enums.add(node.asText()));
        assertEquals(List.of("COMPLETED", "FAILED", "SKIPPED"), enums);
    }

    @Test
    @DisplayName("modify_checklist 用嵌套 schema 表达补丁：步骤内容项是对象数组")
    void modifyChecklistSchemaDescribesNestedPatch() throws Exception {
        JsonNode schema = schemaOf(ModifyChecklistTool.class);
        JsonNode contentItem = schema.path("properties").path("stepContents").path("items");

        assertEquals("object", contentItem.path("type").asText());
        assertEquals(List.of("stepId", "content"), requiredOf(contentItem));
        assertTrue(schema.path("required").toString().contains("checklistId"), "必须要求权威清单标识");
    }

    @Test
    @DisplayName("工具描述写明与 create_plan 的边界，并说明何时才建清单")
    void descriptionsStateTheBoundaryWithCreatePlan() {
        for (Class<? extends ToolExecutor> type : List.of(CreateChecklistTool.class,
                UpdateChecklistStepTool.class, ModifyChecklistTool.class, DeleteChecklistTool.class)) {
            String description = type.getAnnotation(com.summit.core.anno.Tool.class).description();
            assertTrue(description.toLowerCase().contains("create_plan"),
                    type.getSimpleName() + " 的描述必须点明与 create_plan 的边界");
        }
        String createDescription = CreateChecklistTool.class.getAnnotation(com.summit.core.anno.Tool.class)
                .description();
        assertTrue(createDescription.contains("several distinct steps"),
                "必须说明只对多步任务建清单");
        assertTrue(createDescription.contains("single-step") || createDescription.contains("does not need"),
                "必须说明单步任务不要建清单");
    }

    @Test
    @DisplayName("默认 Agent 工具集包含四个清单工具：否则裸默认 Agent 无法使用")
    void defaultAgentToolsContainChecklistTools() {
        assertTrue(ToolCatalog.DEFAULT_AGENT_TOOLS.containsAll(List.of(
                ToolCatalog.CREATE_CHECKLIST, ToolCatalog.UPDATE_CHECKLIST_STEP,
                ToolCatalog.MODIFY_CHECKLIST, ToolCatalog.DELETE_CHECKLIST)));
    }

    private JsonNode schemaOf(Class<? extends ToolExecutor> type) throws Exception {
        return objectMapper.readTree(definition(type).parametersJsonSchema());
    }

    private List<String> requiredOf(JsonNode schema) {
        List<String> required = new java.util.ArrayList<>();
        schema.path("required").forEach(node -> required.add(node.asText()));
        return required;
    }

    private ToolDefinition<?> definition(Class<? extends ToolExecutor> type) {
        ToolExecutor executor = mock(type);
        return AnnotatedToolTestDefinitions.create(type, executor);
    }
}
