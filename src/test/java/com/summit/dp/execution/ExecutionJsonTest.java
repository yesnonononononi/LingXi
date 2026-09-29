package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException;
import com.summit.core.agent.*;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.*;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.local.LocalInstance;
import com.summit.dp.workspace.application.convert.LingXiWorkspaceSpec;
import com.summit.sandbox.docker.DockerWorkspaceSpec;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ExecutionJsonTest {
    private final ObjectMapper mapper = new JsonConfig().objectMapper();

    @Test
    void roundTripsCompleteExecutionForLocalAndDockerWorkspaces() throws Exception {
        LingXiWorkspaceSpec local = new LingXiWorkspaceSpec("local", "D:/workspace", LocalInstance.ID, Map.of());
        DockerWorkspaceSpec docker = DockerWorkspaceSpec.builder().workDir("/workspace").hostDir("D:/workspace")
                .principal(LocalInstance.ID).reuseByHostDirectory(true).build();
        for (WorkspaceSpec spec : List.of(local, docker)) {
            Execution original = execution(spec, Map.of(ExecutionAttributes.SESSION_ID, "201",
                    ExecutionAttributes.MODEL_CONFIG_ID, "301"));
            String json = mapper.writeValueAsString(original);
            Execution restored = mapper.readValue(json, Execution.class);

            assertEquals(mapper.readTree(json), mapper.readTree(mapper.writeValueAsString(restored)));
            assertEquals(spec, restored.getAgentRequest().getWorkspaceSpec());
            assertEquals(201, ExecutionIdentity.sessionId(restored));
            assertEquals("test-original-key", restored.getAgentRequest().getModelConfig().getApiKey());
            assertEquals(Duration.ofMillis(1250), restored.getAgentRequest().getModelConfig().getTimeout());
            assertEquals(original.getCreateAt(), restored.getCreateAt());
            assertEquals(12, restored.getTokenUsage().getTotalTokens());
            assertInstanceOf(SystemMessageEntity.class, restored.getMessages().get(0));
            assertInstanceOf(UserMessageEntity.class, restored.getMessages().get(1));
            assertInstanceOf(AiMessageEntity.class, restored.getMessages().get(2));
            assertInstanceOf(ToolMessageEntity.class, restored.getMessages().get(3));
            assertTrue(mapper.readTree(json).path("messages").isArray());
            assertTrue(mapper.readTree(json).path("agentRequest").path("workspaceSpec").isObject());
            assertFalse(mapper.readTree(json).has("formatVersion"));
        }
    }

    @Test
    void restoresModelWithoutDatabaseOrYamlLookup() throws Exception {
        Execution restored = mapper.readValue(mapper.writeValueAsString(execution(null,
                Map.of(ExecutionAttributes.SESSION_ID, "201"))), Execution.class);
        assertEquals("test-original-key", restored.getAgentRequest().getModelConfig().getApiKey());
    }

    @Test
    void rejectsLegacyMappedSnapshots() {
        for (int version : new int[]{0, 1, 2}) {
            String json = "{\"formatVersion\":" + version + ",\"id\":\"101\",\"request\":{}}";
            assertThrows(UnrecognizedPropertyException.class, () -> mapper.readValue(json, Execution.class));
        }
        assertThrows(UnrecognizedPropertyException.class,
                () -> mapper.readValue("{\"id\":\"101\",\"request\":{}}", Execution.class));
    }

    @Test
    void preservesRequestHistorySeparatelyFromMutableExecutionHistory() throws Exception {
        Execution original = execution(null, Map.of());
        original.getAgentRequest().setMessages(List.of(UserMessageEntity.from("original request")));
        Execution restored = mapper.readValue(mapper.writeValueAsString(original), Execution.class);
        assertEquals(4, restored.getMessages().size());
        assertEquals("original request", restored.getAgentRequest().getMessages().getFirst().text());
        assertDoesNotThrow(() -> restored.getMessages().add(UserMessageEntity.from("next")));
        assertDoesNotThrow(() -> restored.getAgentRequest().getMessages().add(UserMessageEntity.from("another")));
        assertEquals(5, restored.getMessages().size());
        assertEquals(2, restored.getAgentRequest().getMessages().size());
    }

    @Test
    void keepsBusinessLongIdentifiersAsStrings() throws Exception {
        long id = 9007199254740993L;
        assertEquals("\"9007199254740993\"", mapper.writeValueAsString(id));
        Execution restored = mapper.readValue(mapper.writeValueAsString(execution(null,
                Map.of(ExecutionAttributes.SESSION_ID, id))), Execution.class);
        assertEquals(id, ExecutionIdentity.sessionId(restored));
    }

    private Execution execution(WorkspaceSpec spec, Map<String, Object> attributes) {
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").thinking("reason").build();
        List<Message> history = List.of(SystemMessageEntity.builder().text("system").build(),
                UserMessageEntity.from("hello"), ai,
                ToolMessageEntity.builder().id("call-1").name("search").text("result").build());
        ModelConfig model = ModelConfig.builder().baseUrl("https://example.invalid")
                .apiKey("test-original-key").modelName("test-model").provider("default")
                .timeout(Duration.ofMillis(1250)).maxTokens(1024).reasoningEffort("high")
                .returnThinking(true).sendThinking(true).build();
        AgentRequest request = AgentRequest.builder().executionId("101").workspaceSpec(spec).modelConfig(model)
                .messages(history).runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes)
                        .allowOutsideWorkspace(true).build()).build();
        return Execution.builder().id("101").agentId("chatAgent").agentRequest(request)
                .executionState(ExecutionState.SUSPENDED).createAt(Instant.parse("2026-09-27T01:02:03.123456789Z"))
                .messages(history).aiMessage(ai).tokenUsage(TokenUsageEntity.of(12, 8, 4))
                .thinking(true).streaming(true).maxSteps(10).build();
    }
}
