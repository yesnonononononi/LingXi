package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.domain.model.ChecklistRules;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** 大清单只允许在主动读取时展开，写回执始终只保留常量规模的状态。 */
class ChecklistToolOutputTest {
    private static final long SESSION = 4242L;
    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules();
    private final ChecklistService service = mock(ChecklistService.class);

    @Test
    void allWriteExecutorsKeepReceiptsBoundedForTheLargestChecklist() throws Exception {
        for (int count : List.of(1, ChecklistRules.MAX_STEPS)) {
            ChecklistVO snapshot = snapshot(count);
            when(service.create(any())).thenReturn(snapshot);
            when(service.modify(any())).thenReturn(snapshot);
            when(service.delete(any())).thenReturn(snapshot);
            when(service.updateStep(any())).thenReturn(snapshot);
            List<ToolExecuteResult> results = List.of(
                    new CreateChecklistTool(json, service).execute(execution(Map.of("title", "任务", "steps", List.of("一步")))),
                    new ModifyChecklistTool(json, service).execute(execution(Map.of("checklistId", 99L, "newTitle", "新任务"))),
                    new DeleteChecklistTool(json, service).execute(execution(Map.of("checklistId", 99L))),
                    new UpdateChecklistStepTool(json, service).execute(execution(Map.of(
                            "checklistId", 99L, "stepId", 100L, "status", "COMPLETED", "continueNextStep", true))));
            for (ToolExecuteResult result : results) {
                assertTrue(result.isSuccess(), result.getToolOutput());
                JsonNode payload = json.readTree(result.getToolOutput());
                assertEquals(99L, payload.path("checklistId").asLong());
                assertEquals(count, payload.path("stepCount").asInt());
                assertEquals(count - 1, payload.path("openStepCount").asInt());
                assertEquals(1L, payload.path("progressVersion").asLong());
                assertFalse(payload.has("checklist"));
                assertFalse(payload.has("steps"));
                assertFalse(result.getToolOutput().contains("完整正文"));
                assertTrue(result.getToolOutput().length() < 700, result.getToolOutput());
            }
            JsonNode updated = json.readTree(results.getLast().getToolOutput());
            assertEquals(100L, updated.path("step").path("stepId").asLong());
            assertEquals("COMPLETED", updated.path("step").path("status").asText());
            if (count > 1) {
                assertEquals(101L, updated.path("nextStep").path("stepId").asLong());
                assertEquals("IN_PROGRESS", updated.path("nextStep").path("status").asText());
                assertEquals(3, updated.path("nextStep").size());
            } else {
                assertFalse(updated.has("nextStep"));
            }
        }
    }

    @Test
    void queryReturnsAllAuthoritativeStepsAndCannotBeRedirectedToAnotherSession() throws Exception {
        ChecklistVO snapshot = snapshot(ChecklistRules.MAX_STEPS);
        when(service.findCurrent(SESSION)).thenReturn(Optional.of(snapshot));
        ToolExecuteResult result = new GetCurrentChecklistTool(json, service)
                .execute(execution(Map.of("sessionId", 9999L)));
        assertTrue(result.isSuccess(), result.getToolOutput());
        JsonNode checklist = json.readTree(result.getToolOutput()).path("checklist");
        assertEquals(99L, checklist.path("checklistId").asLong());
        assertEquals(SESSION, checklist.path("sessionId").asLong());
        assertEquals(ChecklistRules.MAX_STEPS, checklist.path("steps").size());
        assertEquals(snapshot.getSteps().getLast().getContent(), checklist.path("steps").get(ChecklistRules.MAX_STEPS - 1)
                .path("content").asText());
        assertTrue(GetCurrentChecklistTool.class.getAnnotation(Tool.class).maxOutput() >= result.getToolOutput().length());
        verify(service).findCurrent(SESSION);
        verifyNoMoreInteractions(service);
    }

    @Test
    void queryWithoutAChecklistReturnsNullAndInvalidIdentityDoesNotReadAnything() throws Exception {
        when(service.findCurrent(SESSION)).thenReturn(Optional.empty());
        GetCurrentChecklistTool tool = new GetCurrentChecklistTool(json, service);
        ToolExecuteResult empty = tool.execute(execution(Map.of()));
        assertTrue(empty.isSuccess(), empty.getToolOutput());
        assertTrue(json.readTree(empty.getToolOutput()).path("checklist").isNull());
        assertThrows(IllegalArgumentException.class, () -> tool.execute(ToolExecution.builder()
                .id("invalid").args("{}").attributes(Map.of()).build()));
        verify(service).findCurrent(SESSION);
        verifyNoMoreInteractions(service);
    }

    @Test
    void queryPreservesBusinessErrorsWithoutClaimingAnEmptyChecklist() throws Exception {
        when(service.findCurrent(SESSION)).thenThrow(new ClientException("清单会话标识无效"));
        ToolExecuteResult result = new GetCurrentChecklistTool(json, service).execute(execution(Map.of()));
        assertFalse(result.isSuccess());
        assertEquals("清单会话标识无效", result.getToolOutput());
    }

    private ChecklistVO snapshot(int count) {
        List<ChecklistVO.StepVO> steps = new ArrayList<>();
        for (int index = 0; index < count; index++) {
            steps.add(ChecklistVO.StepVO.builder().stepId(100L + index).seq(index + 1)
                    .content("完整正文" + "约束".repeat((ChecklistRules.MAX_STEP_CONTENT_LENGTH - 4) / 2))
                    .status(index == 0 ? "COMPLETED" : index == 1 ? "IN_PROGRESS" : "PENDING").build());
        }
        return ChecklistVO.builder().checklistId(99L).sessionId(SESSION).title("完整清单")
                .status(count == 1 ? "COMPLETED" : "ACTIVE").progressVersion(1L).steps(steps).build();
    }

    private ToolExecution execution(Map<String, Object> args) throws Exception {
        return ToolExecution.builder().id("checklist-output").args(json.writeValueAsString(args))
                .attributes(Map.of(ExecutionAttributes.SESSION_ID, SESSION)).build();
    }
}
