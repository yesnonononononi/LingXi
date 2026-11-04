package com.summit.dp.checklist.infrastructure;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.domain.model.Checklist;
import com.summit.dp.checklist.domain.model.ChecklistStatus;
import com.summit.dp.checklist.support.ChecklistTestDatabase;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.tools.checklist.UpdateChecklistStepTool;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** 汇总态必须落库，结构修正和旧数据迁移不能绕过真实步骤结果。 */
class ChecklistResultPersistenceTest {
    private static final long SESSION = 7711L;
    private ChecklistTestDatabase fixture;
    private ChecklistService service;

    @BeforeEach
    void start() {
        fixture = ChecklistTestDatabase.start("checklist-result");
        service = fixture.service();
    }

    @AfterEach
    void close() {
        fixture.close();
    }

    @Test
    void batchToolPersistsEachResultTogetherAndRetryPreservesProgress() throws Exception {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION, null, "阶段交接", List.of("验证一", "验证二", "后续工作")));
        long first = created.getSteps().getFirst().getStepId();
        long second = created.getSteps().get(1).getStepId();
        long third = created.getSteps().getLast().getStepId();
        ObjectMapper json = new ObjectMapper();
        UpdateChecklistStepTool tool = new UpdateChecklistStepTool(json, service);
        List<Map<String, Object>> updates = List.of(
                Map.of("stepId", first, "status", "COMPLETED"),
                Map.of("stepId", second, "status", "FAILED"),
                Map.of("stepId", third, "status", "IN_PROGRESS"));
        ToolExecution request = ToolExecution.builder().id("batch").args(json.writeValueAsString(Map.of("updates", updates)))
                .attributes(Map.of(ExecutionAttributes.SESSION_ID, SESSION)).build();

        ToolExecuteResult result = tool.execute(request);
        assertTrue(result.isSuccess(), result.getToolOutput());
        JsonNode receipt = json.readTree(result.getToolOutput());
        assertEquals(2L, receipt.path("progressVersion").asLong());
        assertEquals(1, receipt.path("openStepCount").asInt());
        ChecklistVO saved = service.findActive(SESSION).orElseThrow();
        assertEquals(List.of("COMPLETED", "FAILED", "IN_PROGRESS"),
                saved.sortedSteps().stream().map(ChecklistVO.StepVO::getStatus).toList());

        ToolExecuteResult retry = tool.execute(request);
        assertTrue(retry.isSuccess(), retry.getToolOutput());
        assertEquals(saved, service.findActive(SESSION).orElseThrow());
    }

    @Test
    void batchRejectsInvalidOrAmbiguousEntriesWithoutChangingAnyStep() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION, null, "批量校验", List.of("一步", "两步")));
        long first = created.getSteps().getFirst().getStepId();
        long second = created.getSteps().getLast().getStepId();
        ChecklistCommand.StepStatusUpdate complete = new ChecklistCommand.StepStatusUpdate(first, "COMPLETED");
        for (ChecklistCommand.StepStatusUpdate invalid : List.of(
                new ChecklistCommand.StepStatusUpdate(second, "DONE"),
                new ChecklistCommand.StepStatusUpdate(first, "FAILED"),
                new ChecklistCommand.StepStatusUpdate(-1L, "COMPLETED"))) {
            ChecklistCommand batch = ChecklistCommand.builder().sessionId(SESSION).checklistId(created.getChecklistId())
                    .updates(List.of(complete, invalid)).build();
            assertThrows(ClientException.class, () -> service.updateStep(batch));
        }
        ChecklistCommand mixed = ChecklistCommand.builder().sessionId(SESSION).checklistId(created.getChecklistId())
                .stepId(second).status("COMPLETED").updates(List.of(complete)).build();
        assertThrows(ClientException.class, () -> service.updateStep(mixed));

        ChecklistVO saved = service.findActive(SESSION).orElseThrow();
        assertEquals(0L, saved.getProgressVersion());
        assertEquals(List.of("PENDING", "PENDING"), saved.sortedSteps().stream().map(ChecklistVO.StepVO::getStatus).toList());
    }

    @Test
    void closedResultsDistinguishFailuresSkipsAndCompleteSuccessInStorage() {
        for (String result : List.of("FAILED", "SKIPPED", "COMPLETED")) {
            ChecklistVO created = service.create(ChecklistCommand.create(SESSION, null, "结果", List.of("一步", "两步")));
            long first = created.getSteps().getFirst().getStepId();
            long second = created.getSteps().get(1).getStepId();
            service.updateStep(ChecklistCommand.updateStep(SESSION, created.getChecklistId(), first, "SKIPPED"));
            ChecklistVO finished = service.updateStep(ChecklistCommand.updateStep(SESSION, created.getChecklistId(), second, result));
            String expected = "FAILED".equals(result) ? "FAILED" : "CLOSED";
            assertEquals(expected, finished.getStatus());
            assertEquals(expected, fixture.mapper().selectById(created.getChecklistId()).getStatus());
            assertTrue(service.findActive(SESSION).isEmpty());
            ChecklistVO corrected = service.updateStep(ChecklistCommand.updateStep(SESSION, created.getChecklistId(), first, "COMPLETED"));
            String correctedStatus = "FAILED".equals(result) ? "FAILED" : "SKIPPED".equals(result) ? "CLOSED" : "COMPLETED";
            assertEquals(correctedStatus, corrected.getStatus());
            assertEquals(3L, corrected.getProgressVersion());
        }
    }

    @Test
    void closedChecklistCanBeRewordedAndNewWorkReactivatesItWithoutInventingProgress() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION, null, "原任务", List.of("一步")));
        long stepId = created.getSteps().getFirst().getStepId();
        service.updateStep(ChecklistCommand.updateStep(SESSION, created.getChecklistId(), stepId, "FAILED"));
        ChecklistVO renamed = service.modify(ChecklistCommand.modify(SESSION, created.getChecklistId(), "修正文案",
                List.of(new ChecklistCommand.StepContent(stepId, "真实失败原因")), null, null, null));
        assertEquals("FAILED", renamed.getStatus());
        assertEquals(1L, renamed.getProgressVersion());
        assertEquals("真实失败原因", renamed.getSteps().getFirst().getContent());
        ChecklistVO reopened = service.modify(ChecklistCommand.modify(SESSION, created.getChecklistId(), null,
                null, List.of("重试验证"), null, null));
        assertEquals("ACTIVE", reopened.getStatus());
        assertEquals(1L, reopened.getProgressVersion());
        assertEquals("FAILED", reopened.getSteps().getFirst().getStatus());
        assertEquals("PENDING", reopened.getSteps().get(1).getStatus());
        assertEquals(created.getChecklistId(), service.findCurrent(SESSION).orElseThrow().getChecklistId());
    }

    @Test
    void structuralReactivationCannotStealAnotherActiveSlotOrLeavePartialChanges() {
        ChecklistVO old = service.create(ChecklistCommand.create(SESSION, null, "旧任务", List.of("一步")));
        service.updateStep(ChecklistCommand.updateStep(SESSION, old.getChecklistId(), old.getSteps().getFirst().getStepId(), "COMPLETED"));
        ChecklistVO active = service.create(ChecklistCommand.create(SESSION, null, "新任务", List.of("新一步")));
        ClientException error = assertThrows(ClientException.class, () -> service.modify(ChecklistCommand.modify(
                SESSION, old.getChecklistId(), "不应落库的标题", null, List.of("重新开始"), null, null)));
        assertTrue(error.getMessage().contains("已有活动清单"));
        Checklist reloaded = fixture.repository().findByIdWithSteps(old.getChecklistId()).orElseThrow();
        assertEquals("旧任务", reloaded.getTitle());
        assertEquals(ChecklistStatus.COMPLETED, reloaded.getStatus());
        assertEquals(1, reloaded.getSteps().size());
        assertEquals(active.getChecklistId(), service.findActive(SESSION).orElseThrow().getChecklistId());
    }

    @Test
    void omittedIdExplainsHowToEditAClosedChecklistAndDeletedHistoryRemainsReadOnly() {
        ChecklistVO old = service.create(ChecklistCommand.create(SESSION, null, "任务", List.of("一步")));
        long stepId = old.getSteps().getFirst().getStepId();
        service.updateStep(ChecklistCommand.updateStep(SESSION, old.getChecklistId(), stepId, "COMPLETED"));
        ClientException error = assertThrows(ClientException.class, () -> service.updateStep(
                ChecklistCommand.updateStep(SESSION, null, stepId, "PENDING")));
        assertTrue(error.getMessage().contains("checklistId"));
        assertTrue(error.getMessage().contains("get_current_checklist"));
        service.delete(ChecklistCommand.delete(SESSION, old.getChecklistId()));
        assertThrows(ClientException.class, () -> service.modify(ChecklistCommand.modify(
                SESSION, old.getChecklistId(), "禁止修改", null, null, null, null)));
    }

}
