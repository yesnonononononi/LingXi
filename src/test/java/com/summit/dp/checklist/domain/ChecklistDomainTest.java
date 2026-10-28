package com.summit.dp.checklist.domain;

import com.summit.dp.checklist.domain.model.Checklist;
import com.summit.dp.checklist.domain.model.ChecklistModification;
import com.summit.dp.checklist.domain.model.ChecklistMutation;
import com.summit.dp.checklist.domain.model.ChecklistRules;
import com.summit.dp.checklist.domain.model.ChecklistStatus;
import com.summit.dp.checklist.domain.model.ChecklistStep;
import com.summit.dp.checklist.domain.model.ChecklistStepStatus;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 清单聚合的状态机与结构修改规则（纯领域，无数据库）。
 *
 * <p>覆盖计划书里点名要守住的边界：终态不可重开、无变化不消耗进展版本、
 * 最后一个待处理步骤被删掉要收口、删光步骤要拒绝。</p>
 */
class ChecklistDomainTest {

    private static final long SESSION_ID = 9001L;
    private static final long CHECKLIST_ID = 100L;

    @Test
    void startingAStepKeepsReminderBudgetAndRemainsUnresolved() {
        Checklist checklist = checklist("编译", "测试");
        long first = checklist.getSteps().get(0).getId();
        checklist.applyReminderFact(77L);
        assertTrue(checklist.changeStepStatus(first, ChecklistStepStatus.IN_PROGRESS).checklistChanged());
        assertEquals(ChecklistStepStatus.IN_PROGRESS, checklist.getSteps().get(0).getStatus());
        assertEquals(0L, checklist.getProgressVersion());
        assertTrue(checklist.isRemindStatus());
        assertEquals(2, checklist.pendingSteps().size());
        assertFalse(checklist.changeStepStatus(first, ChecklistStepStatus.IN_PROGRESS).checklistChanged());
        checklist.changeStepStatus(checklist.getSteps().get(1).getId(), ChecklistStepStatus.SKIPPED);
        assertTrue(checklist.hasPendingSteps());
        assertEquals(ChecklistStatus.ACTIVE, checklist.getStatus());
        checklist.changeStepStatus(first, ChecklistStepStatus.COMPLETED);
        assertEquals(2L, checklist.getProgressVersion());
        assertEquals(ChecklistStatus.COMPLETED, checklist.getStatus());
        assertThrows(ClientException.class, () -> checklist.changeStepStatus(first, ChecklistStepStatus.IN_PROGRESS));
    }

    @Test
    @DisplayName("新建清单：步骤按传入顺序编号，进展版本从 0 开始，提醒未使用")
    void createStartsActiveWithNumberedPendingSteps() {
        Checklist checklist = checklist("编译", "跑测试", "写记录");

        assertEquals(ChecklistStatus.ACTIVE, checklist.getStatus());
        assertEquals(3, checklist.getSteps().size());
        assertEquals(List.of(1, 2, 3), checklist.getSteps().stream().map(ChecklistStep::getSeq).toList());
        assertEquals(0L, checklist.getProgressVersion());
        assertFalse(checklist.isRemindStatus());
        assertTrue(checklist.hasPendingSteps());
    }

    @Test
    @DisplayName("空步骤清单直接拒绝：空清单只会白占唯一额度")
    void emptyStepListIsRejected() {
        ClientException error = assertThrows(ClientException.class,
                () -> Checklist.create(CHECKLIST_ID, SESSION_ID, null, "标题", List.of(), Instant.now()));
        assertTrue(error.getMessage().contains("至少"), error.getMessage());
    }

    @Test
    @DisplayName("标题与步骤内容都有长度上限，且上限来自同一份领域常量")
    void titleAndContentLengthAreBounded() {
        String tooLongTitle = "标".repeat(ChecklistRules.MAX_TITLE_LENGTH + 1);
        assertThrows(ClientException.class, () -> Checklist.create(CHECKLIST_ID, SESSION_ID, null,
                tooLongTitle, List.of(ChecklistStep.pending(11L, CHECKLIST_ID, 1, "内容", Instant.now())),
                Instant.now()));

        String tooLongContent = "内".repeat(ChecklistRules.MAX_STEP_CONTENT_LENGTH + 1);
        ClientException error = assertThrows(ClientException.class,
                () -> ChecklistStep.pending(12L, CHECKLIST_ID, 1, tooLongContent, Instant.now()));
        assertTrue(error.getMessage().contains("不能超过"), error.getMessage());
    }

    @Test
    @DisplayName("同一状态重复提交是无变化：不递增进展版本、不重置提醒额度")
    void repeatedSameStatusIsNoChange() {
        Checklist checklist = checklist("编译", "跑测试");
        checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.COMPLETED);
        checklist.applyReminderFact(77L);
        long versionAtReminder = checklist.getProgressVersion();
        Instant updateAtAtReminder = checklist.getUpdateAt();

        ChecklistMutation mutation = checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.COMPLETED);

        assertFalse(mutation.checklistChanged());
        assertEquals(versionAtReminder, checklist.getProgressVersion());
        assertTrue(checklist.isRemindStatus(), "重复提交不得重置提醒额度，否则能无限换取续轮");
        assertEquals(updateAtAtReminder, checklist.getUpdateAt(), "无变化不应刷新清单时间");
    }

    @Test
    @DisplayName("推进到终态会递增进展版本并清空提醒标记")
    void advancingAStepResetsReminderQuota() {
        Checklist checklist = checklist("编译", "跑测试");
        checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.COMPLETED);
        checklist.applyReminderFact(77L);
        assertTrue(checklist.isRemindStatus());

        ChecklistMutation mutation = checklist.changeStepStatus(stepId(checklist, 2), ChecklistStepStatus.SKIPPED);

        assertTrue(mutation.checklistChanged());
        assertEquals(List.of(stepId(checklist, 2)), mutation.changedSteps().stream()
                .map(ChecklistStep::getId).toList());
        assertEquals(2L, checklist.getProgressVersion());
        assertFalse(checklist.isRemindStatus(), "实际推进必须重置提醒额度");
    }

    @Test
    @DisplayName("终态不可重开，也不能改成另一个终态")
    void terminalStepCannotBeReopenedOrReclassified() {
        Checklist checklist = checklist("编译", "跑测试");
        long stepId = stepId(checklist, 1);
        checklist.changeStepStatus(stepId, ChecklistStepStatus.COMPLETED);

        ClientException reopened = assertThrows(ClientException.class,
                () -> checklist.changeStepStatus(stepId, ChecklistStepStatus.PENDING));
        assertTrue(reopened.getMessage().contains("不能退回"), reopened.getMessage());

        ClientException reclassified = assertThrows(ClientException.class,
                () -> checklist.changeStepStatus(stepId, ChecklistStepStatus.FAILED));
        assertTrue(reclassified.getMessage().contains("另一个终态"), reclassified.getMessage());
    }

    @Test
    @DisplayName("全部步骤进入终态即收口为 COMPLETED，FAILED 不阻止收口")
    void allTerminalStepsCompleteTheChecklist() {
        Checklist checklist = checklist("编译", "跑测试");
        checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.COMPLETED);
        checklist.changeStepStatus(stepId(checklist, 2), ChecklistStepStatus.FAILED);

        assertEquals(ChecklistStatus.COMPLETED, checklist.getStatus());
        assertFalse(checklist.hasPendingSteps());
        assertThrows(ClientException.class,
                () -> checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.FAILED),
                "已收口的清单不能再写");
    }

    @Test
    @DisplayName("结构修改不重置提醒额度：改标题、改文案、增删重排都不行")
    void structuralModificationNeverResetsQuota() {
        Checklist checklist = checklist("编译", "跑测试");
        checklist.applyReminderFact(77L);
        long versionAtReminder = checklist.getProgressVersion();

        checklist.applyModification(new ChecklistModification("新标题",
                Map.of(stepId(checklist, 1), "编译全部模块"),
                List.of(new ChecklistModification.NewStep(501L, "写验证记录")),
                List.of(), List.of()));

        assertTrue(checklist.isRemindStatus(), "结构修改不能换取续轮额度");
        assertEquals(versionAtReminder, checklist.getProgressVersion());
        assertEquals("新标题", checklist.getTitle());
    }

    @Test
    @DisplayName("改文案保留步骤原状态，不能借改文案把终态变回待处理")
    void renamingKeepsStepStatus() {
        Checklist checklist = checklist("编译", "跑测试");
        long stepId = stepId(checklist, 1);
        checklist.changeStepStatus(stepId, ChecklistStepStatus.COMPLETED);

        checklist.applyModification(new ChecklistModification(null, Map.of(stepId, "编译整个仓库"),
                List.of(), List.of(), null));
        ChecklistStep step = checklist.getSteps().getFirst();
        assertEquals(ChecklistStepStatus.COMPLETED, step.getStatus());
        assertEquals("编译整个仓库", step.getContent());
    }

    @Test
    @DisplayName("删掉最后一个待处理步骤时同事务收口为 COMPLETED")
    void removingLastPendingStepCompletesChecklist() {
        Checklist checklist = checklist("编译", "跑测试");
        long first = stepId(checklist, 1);
        long second = stepId(checklist, 2);
        checklist.changeStepStatus(first, ChecklistStepStatus.COMPLETED);

        ChecklistMutation mutation = checklist.applyModification(new ChecklistModification(null, Map.of(),
                List.of(), List.of(second), null));

        assertEquals(List.of(second), mutation.removedStepIds());
        assertEquals(ChecklistStatus.COMPLETED, checklist.getStatus());
        assertTrue(mutation.checklistChanged());
    }

    @Test
    @DisplayName("不能删光步骤，也不能漏掉重排序里的步骤")
    void cannotRemoveEveryStepOrDropOneFromReorder() {
        Checklist checklist = checklist("编译", "跑测试");
        long first = stepId(checklist, 1);
        long second = stepId(checklist, 2);

        ClientException wiped = assertThrows(ClientException.class,
                () -> checklist.applyModification(new ChecklistModification(null, Map.of(), List.of(),
                        List.of(first, second), null)));
        assertTrue(wiped.getMessage().contains("不能删光"), wiped.getMessage());
        assertEquals(2, checklist.getSteps().size(), "校验失败不得留下半删状态");

        ClientException partialOrder = assertThrows(ClientException.class,
                () -> checklist.applyModification(new ChecklistModification(null, Map.of(), List.of(),
                        List.of(), List.of(first))));
        assertTrue(partialOrder.getMessage().contains("全部"), partialOrder.getMessage());
    }

    @Test
    @DisplayName("重排只改 seq，稳定 stepId 与状态都不变")
    void reorderOnlyRewritesSequence() {
        Checklist checklist = checklist("一", "二", "三");
        long first = stepId(checklist, 1);
        long second = stepId(checklist, 2);
        long third = stepId(checklist, 3);

        checklist.applyModification(new ChecklistModification(null, Map.of(), List.of(), List.of(),
                List.of(third, first, second)));

        List<ChecklistStep> steps = checklist.getSteps();
        assertEquals(List.of(third, first, second), steps.stream().map(ChecklistStep::getId).toList());
        assertEquals(List.of(1, 2, 3), steps.stream().map(ChecklistStep::getSeq).toList());
        assertTrue(steps.stream().allMatch(ChecklistStep::isPending));
    }

    @Test
    @DisplayName("非活动状态拒绝一切写入，UNFINISHED 与 DELETED 都不可改")
    void terminalChecklistsRejectWrites() {
        Checklist checklist = checklist("编译");
        checklist.markUnfinished();
        assertEquals(ChecklistStatus.UNFINISHED, checklist.getStatus());
        ClientException error = assertThrows(ClientException.class,
                () -> checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.COMPLETED));
        assertTrue(error.getMessage().contains("UNFINISHED"), error.getMessage());

        Checklist deleted = checklist("编译");
        deleted.softDelete();
        assertEquals(ChecklistStatus.DELETED, deleted.getStatus());
        assertThrows(ClientException.class, deleted::softDelete);
    }

    @Test
    @DisplayName("跨会话访问一律拒绝，不靠调用方自觉")
    void crossSessionAccessIsRejected() {
        Checklist checklist = checklist("编译");
        checklist.requireSession(SESSION_ID);
        ClientException error = assertThrows(ClientException.class,
                () -> checklist.requireSession(SESSION_ID + 1));
        assertTrue(error.getMessage().contains("不属于当前会话"), error.getMessage());
    }

    @Test
    @DisplayName("步骤状态解析只接受三个终态取值")
    void stepStatusParsingRejectsAnythingElse() {
        assertSame(ChecklistStepStatus.COMPLETED, ChecklistRules.parseStepStatus("completed"));
        assertSame(ChecklistStepStatus.SKIPPED, ChecklistRules.parseStepStatus(" SKIPPED "));
        assertThrows(ClientException.class, () -> ChecklistRules.parseStepStatus("PENDING"));
        assertThrows(ClientException.class, () -> ChecklistRules.parseStepStatus("DONE"));
        assertThrows(ClientException.class, () -> ChecklistRules.parseStepStatus(null));
    }

    private Checklist checklist(String... contents) {
        long checklistId = CHECKLIST_ID;
        List<ChecklistStep> steps = new ArrayList<>();
        long stepId = 1L;
        for (String content : contents) {
            steps.add(ChecklistStep.pending(stepId++, checklistId, steps.size() + 1, content, Instant.now()));
        }
        return Checklist.create(checklistId, SESSION_ID, 42L, "执行清单", steps, Instant.now());
    }

    private long stepId(Checklist checklist, int seq) {
        return checklist.getSteps().stream().filter(step -> step.getSeq() == seq)
                .findFirst().orElseThrow().getId();
    }
}
