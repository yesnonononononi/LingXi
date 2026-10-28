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
 * <p>覆盖状态回退、无变化不消耗进展版本、
 * 最后一个待处理步骤被删掉要收口、删光步骤要拒绝。</p>
 */
class ChecklistDomainTest {

    private static final long SESSION_ID = 9001L;
    private static final long CHECKLIST_ID = 100L;

    @Test
    void continuingUsesCurrentOrderSkipsTerminalStepsAndLeavesEarlierWorkAlone() {
        Checklist checklist = checklist("一", "二", "三", "四", "五");
        checklist.changeStepStatus(2L, ChecklistStepStatus.COMPLETED);
        checklist.changeStepStatus(4L, ChecklistStepStatus.SKIPPED);
        checklist.applyModification(new ChecklistModification(null, Map.of(), List.of(), List.of(),
                List.of(5L, 3L, 2L, 1L, 4L)));
        checklist.applyReminderFact(77L);

        ChecklistMutation mutation = checklist.changeStepStatus(3L, ChecklistStepStatus.FAILED, true);

        assertEquals(List.of(3L, 1L), mutation.changedSteps().stream().map(ChecklistStep::getId).toList());
        assertEquals(List.of(ChecklistStepStatus.PENDING, ChecklistStepStatus.FAILED, ChecklistStepStatus.COMPLETED,
                ChecklistStepStatus.IN_PROGRESS, ChecklistStepStatus.SKIPPED), checklist.getSteps().stream()
                .map(ChecklistStep::getStatus).toList());
        assertEquals(3L, checklist.getProgressVersion());
        assertFalse(checklist.isRemindStatus());
        assertEquals(ChecklistStatus.ACTIVE, checklist.getStatus());
    }

    @Test
    void repeatedCompletionCannotStartAnotherStepAfterTheNextOneFinished() {
        Checklist checklist = checklist("一", "二", "三");
        checklist.changeStepStatus(1L, ChecklistStepStatus.COMPLETED, true);
        assertEquals(ChecklistStepStatus.IN_PROGRESS, checklist.getSteps().get(1).getStatus());
        checklist.changeStepStatus(2L, ChecklistStepStatus.COMPLETED);
        checklist.applyReminderFact(77L);
        Instant timestamp = checklist.getUpdateAt();
        Instant pendingTimestamp = checklist.getSteps().get(2).getUpdateAt();

        ChecklistMutation repeated = checklist.changeStepStatus(1L, ChecklistStepStatus.COMPLETED, true);

        assertFalse(repeated.checklistChanged());
        assertTrue(repeated.changedSteps().isEmpty());
        assertEquals(ChecklistStepStatus.PENDING, checklist.getSteps().get(2).getStatus());
        assertEquals(pendingTimestamp, checklist.getSteps().get(2).getUpdateAt());
        assertEquals(timestamp, checklist.getUpdateAt());
        assertEquals(2L, checklist.getProgressVersion());
        assertTrue(checklist.reminderOwnedBy(77L));
    }

    @Test
    void continuingKeepsAnAlreadyStartedStepAndCompletesAtTheEnd() {
        for (ChecklistStepStatus result : List.of(ChecklistStepStatus.COMPLETED,
                ChecklistStepStatus.FAILED, ChecklistStepStatus.SKIPPED)) {
            Checklist checklist = checklist("一", "二");
            checklist.changeStepStatus(2L, ChecklistStepStatus.IN_PROGRESS);
            Instant startedAt = checklist.getSteps().get(1).getUpdateAt();
            ChecklistMutation mutation = checklist.changeStepStatus(1L, result, true);
            assertEquals(List.of(1L), mutation.changedSteps().stream().map(ChecklistStep::getId).toList());
            assertEquals(startedAt, checklist.getSteps().get(1).getUpdateAt());
            checklist.changeStepStatus(2L, result, true);
            assertEquals(ChecklistStatus.COMPLETED, checklist.getStatus());
            assertEquals(2L, checklist.getProgressVersion());
        }
    }

    @Test
    void rollbackCannotContinueAndDefaultCompletionDoesNotStartTheNextStep() {
        Checklist checklist = checklist("一", "二");
        Instant timestamp = checklist.getUpdateAt();
        for (ChecklistStepStatus rollback : List.of(ChecklistStepStatus.PENDING, ChecklistStepStatus.IN_PROGRESS)) {
            assertThrows(ClientException.class, () -> checklist.changeStepStatus(1L, rollback, true));
            assertTrue(checklist.getSteps().stream().allMatch(ChecklistStep::isPending));
            assertEquals(timestamp, checklist.getUpdateAt());
        }
        checklist.changeStepStatus(1L, ChecklistStepStatus.COMPLETED);
        assertTrue(checklist.getSteps().get(1).isPending());
    }

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
        checklist.changeStepStatus(first, ChecklistStepStatus.IN_PROGRESS);
        assertEquals(ChecklistStatus.ACTIVE, checklist.getStatus());
        assertEquals(2L, checklist.getProgressVersion());
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
    @DisplayName("步骤回退保留提醒额度与标识，终态结果可以修正")
    void terminalStepCanBeReopenedAndReclassified() {
        Checklist checklist = checklist("编译", "跑测试");
        long stepId = stepId(checklist, 1);
        checklist.changeStepStatus(stepId, ChecklistStepStatus.COMPLETED);

        checklist.applyReminderFact(77L);
        checklist.changeStepStatus(stepId, ChecklistStepStatus.PENDING);
        assertEquals(ChecklistStepStatus.PENDING, checklist.getSteps().getFirst().getStatus());
        assertEquals(stepId, checklist.getSteps().getFirst().getId());
        assertEquals(1L, checklist.getProgressVersion());
        assertTrue(checklist.reminderOwnedBy(77L));
        checklist.changeStepStatus(stepId, ChecklistStepStatus.FAILED);
        checklist.changeStepStatus(stepId, ChecklistStepStatus.SKIPPED);
        assertEquals(ChecklistStepStatus.SKIPPED, checklist.getSteps().getFirst().getStatus());
        assertEquals(3L, checklist.getProgressVersion());
        assertFalse(checklist.isRemindStatus());
    }

    @Test
    @DisplayName("全部步骤进入终态即收口为 COMPLETED，FAILED 不阻止收口")
    void allTerminalStepsCompleteTheChecklist() {
        Checklist checklist = checklist("编译", "跑测试");
        checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.COMPLETED);
        checklist.changeStepStatus(stepId(checklist, 2), ChecklistStepStatus.FAILED);

        assertEquals(ChecklistStatus.COMPLETED, checklist.getStatus());
        assertFalse(checklist.hasPendingSteps());
        checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.FAILED);
        assertEquals(ChecklistStatus.COMPLETED, checklist.getStatus());
        checklist.changeStepStatus(stepId(checklist, 2), ChecklistStepStatus.PENDING);
        assertEquals(ChecklistStatus.ACTIVE, checklist.getStatus());
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
    @DisplayName("未完成清单可修正，已删除清单不可再写")
    void unfinishedChecklistCanResumeButDeletedChecklistRejectsWrites() {
        Checklist checklist = checklist("编译");
        checklist.markUnfinished();
        assertEquals(ChecklistStatus.UNFINISHED, checklist.getStatus());
        checklist.changeStepStatus(stepId(checklist, 1), ChecklistStepStatus.IN_PROGRESS);
        assertEquals(ChecklistStatus.ACTIVE, checklist.getStatus());

        Checklist deleted = checklist("编译");
        deleted.softDelete();
        assertEquals(ChecklistStatus.DELETED, deleted.getStatus());
        assertThrows(ClientException.class, deleted::softDelete);
        assertThrows(ClientException.class,
                () -> deleted.changeStepStatus(stepId(deleted, 1), ChecklistStepStatus.PENDING));
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
    @DisplayName("步骤状态解析包含回退与所有真实结果")
    void stepStatusParsingRejectsAnythingElse() {
        assertSame(ChecklistStepStatus.COMPLETED, ChecklistRules.parseStepStatus("completed"));
        assertSame(ChecklistStepStatus.SKIPPED, ChecklistRules.parseStepStatus(" SKIPPED "));
        assertSame(ChecklistStepStatus.PENDING, ChecklistRules.parseStepStatus(" pending "));
        assertSame(ChecklistStepStatus.IN_PROGRESS, ChecklistRules.parseStepStatus("IN_PROGRESS"));
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
