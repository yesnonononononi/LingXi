package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.image.ReadImageToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.plan.CreatePlanTool;
import com.summit.dp.workflow.infrastructure.tools.require_choice.RequireChoiceToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.CallSubAgentTool;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.PeekTeammateStateTool;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.SendMailToAgentTool;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.ManageCommandToolExecutor;
import java.io.InputStream;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

class StaticToolDeclarationContractTest {
    @Test
    void annotationsPreserveEveryExistingToolContract() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        List<Class<? extends ToolExecutor>> executorTypes = List.of(
                CommandToolDefinitionExecutor.class, ManageCommandToolExecutor.class,
                EditFileToolExecutor.class, ReadFileToolExecutor.class, ReadImageToolExecutor.class,
                RequireChoiceToolExecutor.class, CallSubAgentTool.class, PeekTeammateStateTool.class,
                SendMailToAgentTool.class, CreatePlanTool.class);
        ArrayNode snapshot = mapper.createArrayNode();
        for (Class<? extends ToolExecutor> executorType : executorTypes) {
            ToolExecutor executor = mock(executorType);
            ToolDefinition<?> definition = AnnotatedToolTestDefinitions.create(executorType, executor);
            assertSame(executor, definition.executor());
            ObjectNode row = snapshot.addObject();
            row.put("id", definition.id().toString());
            row.put("name", definition.name());
            row.put("description", definition.description());
            row.set("schema", mapper.readTree(definition.parametersJsonSchema()));
            row.put("timeout", definition.timeout());
            row.put("maxOutput", definition.maxOutput());
            row.put("concurrentPolicy", definition.concurrentPolicy().name());
        }
        try (InputStream baseline = getClass().getResourceAsStream("/tools/static-tool-contracts.json")) {
            assertNotNull(baseline);
            assertEquals(mapper.readTree(baseline), mapper.readTree(snapshot.toString()));
        }
    }
}
