package com.summit.dp.checklist.infrastructure;

import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistReminderContext;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.application.ReminderDecision;
import com.summit.dp.checklist.domain.model.Checklist;
import com.summit.dp.checklist.domain.model.ChecklistStatus;
import com.summit.dp.checklist.domain.model.ChecklistStep;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistMapper;
import com.summit.dp.checklist.infrastructure.persistence.po.ChecklistPO;
import com.summit.dp.checklist.infrastructure.repository.ChecklistRepositoryImpl;
import com.summit.dp.checklist.support.ChecklistTestDatabase;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;

import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.spy;

/**
 * 清单持久化与真实 H2 约束（建表走仓库根 init.sql，不另建测试 schema）。
 *
 * <p>关键证据在这里：{@code uk_checklist_active_session} 必须真的存在于 H2 上，
 * 否则「每会话一份 ACTIVE」只是应用层的一句愿望。所以有一条用例绕过服务直接插两行，
 * 期望数据库自己拒绝。</p>
 */
class ChecklistPersistenceTest {

    private static final long SESSION_ID = 7001L;
    private static final long EXECUTION_ID = 8801L;

    private ChecklistTestDatabase fixture;
    private ChecklistMapper mapper;
    private ChecklistRepositoryImpl repository;
    private ChecklistService service;

    @Test
    void continuingPersistsBothStatesAndRejectsRollbackBeforeWriting() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "继续", List.of("一步", "两步")));
        long first = created.getSteps().getFirst().getStepId();
        ChecklistVO updated = service.updateStep(ChecklistCommand.updateStep(
                SESSION_ID, created.getChecklistId(), first, "COMPLETED", true));
        assertEquals(List.of("COMPLETED", "IN_PROGRESS"), updated.getSteps().stream()
                .map(ChecklistVO.StepVO::getStatus).toList());
        Checklist persisted = repository.findByIdWithSteps(created.getChecklistId()).orElseThrow();
        assertEquals(List.of("COMPLETED", "IN_PROGRESS"), persisted.getSteps().stream()
                .map(step -> step.getStatus().name()).toList());
        assertEquals(1L, persisted.getProgressVersion());
        ClientException rejected = assertThrows(ClientException.class, () -> service.updateStep(
                ChecklistCommand.updateStep(SESSION_ID, created.getChecklistId(), first, "PENDING", true)));
        assertTrue(rejected.getMessage().contains("才能继续下一步"));
        assertEquals("COMPLETED", repository.findByIdWithSteps(created.getChecklistId()).orElseThrow()
                .getSteps().getFirst().getStatus().name());
    }

    @Test
    void failedNextStepWriteRollsBackCurrentCompletionAndReminderReset() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "原子继续", List.of("一步", "两步")));
        repository.claimReminder(repository.findByIdWithSteps(created.getChecklistId()).orElseThrow(), EXECUTION_ID);
        ChecklistRepositoryImpl failing = spy(repository);
        doAnswer(invocation -> {
            invocation.callRealMethod();
            ChecklistStep step = invocation.getArgument(0);
            if (step.getId().equals(created.getSteps().get(1).getStepId())) {
                throw new ClientException("模拟启动下一步失败");
            }
            return null;
        }).when(failing).updateStep(any(ChecklistStep.class));
        ChecklistService faultedService = fixture.serviceWithRepository(failing);
        assertThrows(ClientException.class, () -> faultedService.updateStep(ChecklistCommand.updateStep(
                SESSION_ID, created.getChecklistId(), created.getSteps().getFirst().getStepId(), "COMPLETED", true)));
        Checklist reloaded = repository.findByIdWithSteps(created.getChecklistId()).orElseThrow();
        assertEquals(ChecklistStatus.ACTIVE, reloaded.getStatus());
        assertTrue(reloaded.getSteps().stream().allMatch(ChecklistStep::isPending));
        assertEquals(0L, reloaded.getProgressVersion());
        assertTrue(reloaded.reminderOwnedBy(EXECUTION_ID));
    }

    @Test
    void currentSnapshotRetainsStartedAndCompletedStepsAndExcludesDeletedHistory() {
        assertTrue(service.findCurrent(SESSION_ID).isEmpty());
        ChecklistVO first = service.create(ChecklistCommand.create(SESSION_ID, null, "第一份", List.of("编译")));
        long stepId = first.getSteps().get(0).getStepId();
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, null, stepId, "IN_PROGRESS"));
        ChecklistVO started = service.findCurrent(SESSION_ID).orElseThrow();
        assertEquals("IN_PROGRESS", started.getSteps().get(0).getStatus());
        assertEquals(0L, started.getProgressVersion());
        assertTrue(service.findCurrent(SESSION_ID + 1).isEmpty());
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, null, stepId, "COMPLETED"));
        assertEquals("COMPLETED", service.findCurrent(SESSION_ID).orElseThrow().getStatus());
        ChecklistVO second = service.create(ChecklistCommand.create(SESSION_ID, null, "第二份", List.of("测试")));
        assertEquals(second.getChecklistId(), service.findCurrent(SESSION_ID).orElseThrow().getChecklistId());
        service.delete(ChecklistCommand.delete(SESSION_ID, second.getChecklistId()));
        assertTrue(service.findCurrent(SESSION_ID).isEmpty());
        assertThrows(ClientException.class, () -> service.findCurrent(null));
        assertThrows(ClientException.class, () -> service.findCurrent(0L));
    }

    @BeforeEach
    void setUp() {
        fixture = ChecklistTestDatabase.start("checklist");
        mapper = fixture.mapper();
        repository = fixture.repository();
        service = fixture.service();
    }

    @AfterEach
    void tearDown() {
        if (fixture != null) {
            fixture.close();
        }
    }

    @Test
    @DisplayName("创建清单会落库清单行与全部步骤行，快照带稳定 stepId 与 seq")
    void createPersistsAggregateWithStableIds() {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION_ID, 42L, "本次任务执行清单", List.of("读计划书", "写领域层", "跑测试")));

        assertEquals("ACTIVE", created.getStatus());
        assertEquals(3, created.getSteps().size());
        assertEquals(List.of(1, 2, 3), created.getSteps().stream().map(ChecklistVO.StepVO::getSeq).toList());
        assertNotEquals(created.getSteps().get(0).getStepId(), created.getSteps().get(1).getStepId());

        Checklist reloaded = repository.findActiveBySessionId(SESSION_ID).orElseThrow();
        assertEquals(created.getChecklistId(), reloaded.getId());
        assertEquals(3, reloaded.getSteps().size());
        assertEquals(0L, reloaded.getProgressVersion());
    }

    @Test
    @DisplayName("同一会话第二次创建会被业务检查挡住并给出中文提示")
    void secondCreateInTheSameSessionIsRejected() {
        service.create(ChecklistCommand.create(SESSION_ID, 42L, "清单", List.of("一步")));

        ClientException error = assertThrows(ClientException.class, () -> service.create(
                ChecklistCommand.create(SESSION_ID, 42L, "另一份", List.of("另一步"))));
        assertTrue(error.getMessage().contains("已有活动清单"), error.getMessage());
    }

    @Test
    @DisplayName("绕过服务直插两行 ACTIVE：数据库唯一索引必须自己拒绝")
    void uniqueIndexRejectsSecondActiveRowWithoutService() {
        mapper.insert(activeRow(1L, SESSION_ID));

        DataAccessException error = assertThrows(DataAccessException.class,
                () -> mapper.insert(activeRow(2L, SESSION_ID)));
        assertTrue(String.valueOf(error.getMessage()).toLowerCase().contains("unique"),
                "必须是唯一约束冲突: " + error.getMessage());
    }

    @Test
    @DisplayName("不同会话互不影响：各有各的活动清单")
    void differentSessionsKeepSeparateChecklists() {
        service.create(ChecklistCommand.create(SESSION_ID, null, "甲的清单", List.of("一步")));
        ChecklistVO other = service.create(ChecklistCommand.create(SESSION_ID + 1, null, "乙的清单", List.of("一步")));

        assertTrue(repository.findActiveBySessionId(SESSION_ID).isPresent());
        assertTrue(repository.findActiveBySessionId(SESSION_ID + 1).isPresent());
        assertEquals(SESSION_ID + 1, other.getSessionId());
    }

    @Test
    @DisplayName("全部步骤收口后 ACTIVE 唯一键让位，可以新建下一份清单")
    void completionReleasesTheActiveKey() {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION_ID, null, "清单", List.of("第一步", "第二步")));
        long firstStep = created.getSteps().get(0).getStepId();
        long secondStep = created.getSteps().get(1).getStepId();

        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, null, firstStep, "COMPLETED"));
        ChecklistVO finished = service.updateStep(
                ChecklistCommand.updateStep(SESSION_ID, null, secondStep, "FAILED"));

        assertEquals("FAILED", finished.getStatus());
        assertTrue(repository.findActiveBySessionId(SESSION_ID).isEmpty());
        ChecklistVO next = service.create(ChecklistCommand.create(SESSION_ID, null, "下一份", List.of("重新来")));
        assertEquals("ACTIVE", next.getStatus());
    }

    @Test
    void completedLastStepCanBeRetriedWithoutReopeningOrTouchingANewChecklist() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "旧清单", List.of("一步")));
        long stepId = created.getSteps().getFirst().getStepId();
        ChecklistVO finished = service.updateStep(ChecklistCommand.updateStep(
                SESSION_ID, created.getChecklistId(), stepId, "COMPLETED"));
        Instant persistedUpdate = repository.findByIdWithSteps(created.getChecklistId()).orElseThrow().getUpdateAt();
        ChecklistVO next = service.create(ChecklistCommand.create(SESSION_ID, null, "新清单", List.of("新一步")));

        ChecklistVO repeated = service.updateStep(ChecklistCommand.updateStep(
                SESSION_ID, created.getChecklistId(), stepId, "COMPLETED"));

        assertEquals("COMPLETED", repeated.getStatus());
        assertEquals(finished.getProgressVersion(), repeated.getProgressVersion());
        assertEquals(persistedUpdate, repeated.getUpdateAt());
        assertEquals(next.getChecklistId(), service.findActive(SESSION_ID).orElseThrow().getChecklistId());
        ChecklistVO corrected = service.updateStep(ChecklistCommand.updateStep(
                SESSION_ID, created.getChecklistId(), stepId, "FAILED"));
        assertEquals("FAILED", corrected.getStatus());
        assertEquals("FAILED", corrected.getSteps().getFirst().getStatus());
        ClientException conflict = assertThrows(ClientException.class, () -> service.updateStep(ChecklistCommand.updateStep(
                SESSION_ID, created.getChecklistId(), stepId, "PENDING")));
        assertTrue(conflict.getMessage().contains("已有活动清单"));
        assertEquals("FAILED", repository.findByIdWithSteps(created.getChecklistId()).orElseThrow()
                .getSteps().getFirst().getStatus().name());
        assertThrows(ClientException.class, () -> service.updateStep(ChecklistCommand.updateStep(
                SESSION_ID + 1, created.getChecklistId(), stepId, "COMPLETED")));
        service.delete(ChecklistCommand.delete(SESSION_ID, created.getChecklistId()));
        assertThrows(ClientException.class, () -> service.updateStep(ChecklistCommand.updateStep(
                SESSION_ID, created.getChecklistId(), stepId, "COMPLETED")));
    }

    @Test
    @DisplayName("步骤推进落库并重置提醒额度；重复提交同一状态不改变进展版本")
    void advancingStepResetsReminderQuotaInDatabase() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "清单", List.of("一步", "两步")));
        long checklistId = created.getChecklistId();
        long firstStep = created.getSteps().get(0).getStepId();

        assertTrue(repository.claimReminder(repository.findByIdWithSteps(checklistId).orElseThrow(), EXECUTION_ID), "首次占用额度应成功");
        assertTrue(repository.findByIdWithSteps(checklistId).orElseThrow().isRemindStatus());

        ChecklistVO advanced = service.updateStep(
                ChecklistCommand.updateStep(SESSION_ID, null, firstStep, "COMPLETED"));
        assertFalse(repository.findByIdWithSteps(checklistId).orElseThrow().isRemindStatus(),
                "同事务必须把 remind_status 置回 FALSE");
        Checklist reset = repository.findByIdWithSteps(checklistId).orElseThrow();
        assertNull(reset.getRemindExecutionId(), "数据库中的旧提醒执行必须清空");
        assertNull(reset.getRemindedProgressVersion(), "数据库中的旧提醒版本必须清空");
        assertEquals(1L, advanced.getProgressVersion());

        ChecklistVO repeated = service.updateStep(
                ChecklistCommand.updateStep(SESSION_ID, null, firstStep, "COMPLETED"));
        assertEquals(1L, repeated.getProgressVersion(), "重复提交不得递增进展版本");
    }

    @Test
    void failedStepWriteRollsBackChecklistProgressAndReminderFields() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "回滚", List.of("一步", "两步")));
        repository.claimReminder(repository.findByIdWithSteps(created.getChecklistId()).orElseThrow(), EXECUTION_ID);
        ChecklistRepositoryImpl failing = spy(repository);
        doAnswer(invocation -> {
            invocation.callRealMethod();
            throw new ClientException("模拟步骤写入失败");
        }).when(failing).updateStep(any(ChecklistStep.class));
        ChecklistService faultedService = fixture.serviceWithRepository(failing);

        assertThrows(ClientException.class, () -> faultedService.updateStep(ChecklistCommand.updateStep(
                SESSION_ID, created.getChecklistId(), created.getSteps().getFirst().getStepId(), "COMPLETED")));

        Checklist reloaded = repository.findByIdWithSteps(created.getChecklistId()).orElseThrow();
        assertEquals(0L, reloaded.getProgressVersion());
        assertTrue(reloaded.isRemindStatus());
        assertEquals(EXECUTION_ID, reloaded.getRemindExecutionId());
        assertEquals(0L, reloaded.getRemindedProgressVersion());
        assertTrue(reloaded.getSteps().getFirst().isPending());
    }

    @Test
    void concurrentCreatorsLeaveOnlyOneCompleteAggregate() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<String> first = pool.submit(() -> {
                await(start);
                try {
                    service.create(ChecklistCommand.create(SESSION_ID, null, "甲", List.of("一步", "两步")));
                    return "created";
                } catch (ClientException expected) { return "rejected"; }
            });
            Future<String> second = pool.submit(() -> {
                await(start);
                try {
                    service.create(ChecklistCommand.create(SESSION_ID, null, "乙", List.of("一步", "两步")));
                    return "created";
                } catch (ClientException expected) { return "rejected"; }
            });
            start.countDown();
            assertEquals(Set.of("created", "rejected"), Set.of(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS)));
            assertEquals(1, repository.findAllBySessionId(SESSION_ID).size());
            assertEquals(2, repository.findActiveBySessionId(SESSION_ID).orElseThrow().getSteps().size());
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void reminderWaitsForTheParentLockAndObservesCommittedProgress() throws Exception {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "并发", List.of("一步")));
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch checking = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<ChecklistVO> advancing = pool.submit(() -> fixture.transaction().execute(status -> {
                repository.findByIdForUpdate(created.getChecklistId()).orElseThrow();
                locked.countDown();
                await(release);
                return service.updateStep(ChecklistCommand.updateStep(SESSION_ID, created.getChecklistId(),
                        created.getSteps().getFirst().getStepId(), "COMPLETED"));
            }));
            await(locked);
            Future<ReminderDecision> checkingReminder = pool.submit(() -> {
                checking.countDown();
                return service.remindOnNaturalComplete(new ChecklistReminderContext(SESSION_ID, EXECUTION_ID, null));
            });
            await(checking);
            assertThrows(TimeoutException.class, () -> checkingReminder.get(150, TimeUnit.MILLISECONDS));
            release.countDown();

            assertEquals("COMPLETED", advancing.get(5, TimeUnit.SECONDS).getStatus());
            assertFalse(checkingReminder.get(5, TimeUnit.SECONDS).requiresAnotherRound());
            assertFalse(repository.findByIdWithSteps(created.getChecklistId()).orElseThrow().isRemindStatus());
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    private static void await(CountDownLatch latch) {
        try {
            assertTrue(latch.await(5, TimeUnit.SECONDS), "并发测试未及时到达同步点");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("并发测试被中断", interrupted);
        }
    }

    @Test
    @DisplayName("跨会话更新被拒绝：归属只认会话，不认模型给的标识")
    void crossSessionUpdateIsRejected() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "清单", List.of("一步")));

        ClientException error = assertThrows(ClientException.class, () -> service.updateStep(
                ChecklistCommand.updateStep(SESSION_ID + 999, created.getChecklistId(),
                        created.getSteps().getFirst().getStepId(), "COMPLETED")));
        assertTrue(error.getMessage().contains("不属于当前会话"), error.getMessage());
    }

    @Test
    @DisplayName("结构修改保留稳定 stepId；删掉最后一个待处理步骤即收口")
    void modifyKeepsStepIdsAndCompletesWhenLastPendingStepIsRemoved() {
        ChecklistVO created = service.create(ChecklistCommand.create(
                SESSION_ID, null, "清单", List.of("编译", "跑测试")));
        long firstStep = created.getSteps().get(0).getStepId();
        long secondStep = created.getSteps().get(1).getStepId();
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, null, firstStep, "COMPLETED"));

        ChecklistVO modified = service.modify(ChecklistCommand.modify(SESSION_ID, null, "新标题",
                List.of(new ChecklistCommand.StepContent(firstStep, "编译整个仓库")),
                List.of("补一条验证记录"), List.of(secondStep), List.of()));

        assertEquals("新标题", modified.getTitle());
        assertEquals(2, modified.getSteps().size());
        assertEquals(firstStep, modified.getSteps().get(0).getStepId(), "既有步骤 ID 必须稳定");
        assertEquals("COMPLETED", modified.getSteps().get(0).getStatus());
        assertEquals("编译整个仓库", modified.getSteps().get(0).getContent());
        assertEquals("PENDING", modified.getSteps().get(1).getStatus(), "新增步骤一律待处理");
        assertEquals("ACTIVE", modified.getStatus());
    }

    @Test
    @DisplayName("删光步骤被拒绝，且不留半个聚合")
    void removingEveryStepIsRejectedWithoutPartialWrite() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "清单", List.of("唯一一步")));

        assertThrows(ClientException.class, () -> service.modify(ChecklistCommand.modify(
                SESSION_ID, null, null, null, null,
                List.of(created.getSteps().getFirst().getStepId()), null)));

        Checklist reloaded = repository.findByIdWithSteps(created.getChecklistId()).orElseThrow();
        assertEquals(1, reloaded.getSteps().size());
        assertEquals(ChecklistStatus.ACTIVE, reloaded.getStatus());
    }

    @Test
    @DisplayName("软删释放唯一键、重复删除返回既有事实，历史留痕不物理清除")
    void deleteIsSoftAndIdempotent() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "清单", List.of("一步")));

        ChecklistVO deleted = service.delete(ChecklistCommand.delete(SESSION_ID, created.getChecklistId()));
        assertEquals("DELETED", deleted.getStatus());
        assertEquals("PENDING", deleted.getSteps().getFirst().getStatus());

        ChecklistVO again = service.delete(ChecklistCommand.delete(SESSION_ID, created.getChecklistId()));
        assertEquals("DELETED", again.getStatus(), "重复删除必须返回既有删除事实");

        ChecklistVO next = service.create(ChecklistCommand.create(SESSION_ID, null, "第二份", List.of("一步")));
        assertEquals("ACTIVE", next.getStatus(), "软删后唯一键必须让位");
        assertEquals(2, repository.findAllBySessionId(SESSION_ID).size(), "历史不物理清除");
    }

    @Test
    void reopeningOlderChecklistMakesItCurrentAndPreservesReminderBudget() {
        ChecklistVO old = service.create(ChecklistCommand.create(SESSION_ID, null, "旧清单", List.of("一步")));
        long stepId = old.getSteps().getFirst().getStepId();
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, old.getChecklistId(), stepId, "COMPLETED"));
        ChecklistVO newer = service.create(ChecklistCommand.create(SESSION_ID, null, "新清单", List.of("另一步")));
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, newer.getChecklistId(),
                newer.getSteps().getFirst().getStepId(), "COMPLETED"));
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, old.getChecklistId(), stepId, "IN_PROGRESS"));
        Checklist reopened = repository.findActiveBySessionId(SESSION_ID).orElseThrow();
        assertEquals(old.getChecklistId(), reopened.getId());
        assertEquals(old.getChecklistId(), service.findCurrent(SESSION_ID).orElseThrow().getChecklistId());
        assertEquals(1L, reopened.getProgressVersion());
        repository.claimReminder(reopened, EXECUTION_ID);
        ChecklistVO pending = service.updateStep(ChecklistCommand.updateStep(SESSION_ID, old.getChecklistId(), stepId, "PENDING"));
        assertEquals("PENDING", pending.getSteps().getFirst().getStatus());
        Checklist reloaded = repository.findByIdWithSteps(old.getChecklistId()).orElseThrow();
        assertTrue(reloaded.reminderOwnedBy(EXECUTION_ID));
        assertEquals(1L, reloaded.getProgressVersion());
    }

    @Test
    void deleteCompletesOpenStepsAtomicallyAndKeepsTerminalResultsAndRetryFacts() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "收尾",
                List.of("失败项", "跳过项", "待处理项", "删除整个清单")));
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, null, created.getSteps().get(0).getStepId(), "FAILED"));
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, null, created.getSteps().get(1).getStepId(), "SKIPPED"));
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, null, created.getSteps().get(3).getStepId(), "IN_PROGRESS"));
        repository.claimReminder(repository.findByIdWithSteps(created.getChecklistId()).orElseThrow(), EXECUTION_ID);

        ChecklistVO deleted = service.delete(ChecklistCommand.delete(SESSION_ID, created.getChecklistId(), true));
        assertEquals("DELETED", deleted.getStatus());
        assertEquals(List.of("FAILED", "SKIPPED", "COMPLETED", "COMPLETED"), deleted.getSteps().stream()
                .map(ChecklistVO.StepVO::getStatus).toList());
        Checklist persisted = repository.findByIdWithSteps(created.getChecklistId()).orElseThrow();
        assertEquals(4L, persisted.getProgressVersion());
        assertFalse(persisted.hasPendingSteps());
        assertNull(persisted.getRemindExecutionId());
        assertNull(persisted.getRemindedProgressVersion());
        ChecklistVO retried = service.delete(ChecklistCommand.delete(SESSION_ID, created.getChecklistId(), true));
        assertEquals(deleted.getProgressVersion(), retried.getProgressVersion());
        assertEquals(persisted.getUpdateAt(), retried.getUpdateAt());

        ChecklistVO abandoned = service.create(ChecklistCommand.create(SESSION_ID, null, "放弃", List.of("未完成")));
        service.delete(ChecklistCommand.delete(SESSION_ID, abandoned.getChecklistId()));
        ChecklistVO repeated = service.delete(ChecklistCommand.delete(SESSION_ID, abandoned.getChecklistId(), true));
        assertEquals("PENDING", repeated.getSteps().getFirst().getStatus());
        assertEquals(0L, repeated.getProgressVersion());
    }

    @Test
    void failedDeleteCompletionRollsBackDeletionAndAllStepWrites() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "回滚", List.of("一步", "删除清单")));
        ChecklistRepositoryImpl failing = spy(repository);
        doAnswer(invocation -> {
            invocation.callRealMethod();
            ChecklistStep step = invocation.getArgument(0);
            if (step.getId().equals(created.getSteps().get(1).getStepId())) {
                throw new ClientException("模拟第二步写入失败");
            }
            return null;
        }).when(failing).updateStep(any(ChecklistStep.class));
        ChecklistService faultedService = fixture.serviceWithRepository(failing);
        assertThrows(ClientException.class, () -> faultedService.delete(
                ChecklistCommand.delete(SESSION_ID, created.getChecklistId(), true)));
        Checklist reloaded = repository.findByIdWithSteps(created.getChecklistId()).orElseThrow();
        assertEquals(ChecklistStatus.ACTIVE, reloaded.getStatus());
        assertEquals(0L, reloaded.getProgressVersion());
        assertTrue(reloaded.getSteps().stream().allMatch(ChecklistStep::isPending));
    }

    @Test
    void concurrentReopenAndCreateKeepOneActiveChecklist() throws Exception {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION_ID, null, "旧清单", List.of("一步")));
        long stepId = created.getSteps().getFirst().getStepId();
        service.updateStep(ChecklistCommand.updateStep(SESSION_ID, created.getChecklistId(), stepId, "COMPLETED"));
        ExecutorService pool = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            Future<String> reopening = pool.submit(() -> {
                await(start);
                try {
                    service.updateStep(ChecklistCommand.updateStep(SESSION_ID, created.getChecklistId(), stepId, "PENDING"));
                    return "accepted";
                } catch (ClientException expected) { return "rejected"; }
            });
            Future<String> creating = pool.submit(() -> {
                await(start);
                try {
                    service.create(ChecklistCommand.create(SESSION_ID, null, "新清单", List.of("另一步")));
                    return "accepted";
                } catch (ClientException expected) { return "rejected"; }
            });
            start.countDown();
            assertEquals(Set.of("accepted", "rejected"), Set.of(
                    reopening.get(5, TimeUnit.SECONDS), creating.get(5, TimeUnit.SECONDS)));
            assertEquals(1L, repository.findAllBySessionId(SESSION_ID).stream()
                    .filter(checklist -> checklist.getStatus() == ChecklistStatus.ACTIVE).count());
        } finally {
            start.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    @DisplayName("没有活动清单时提醒判定直接放行，不消费任何额度")
    void reminderWithoutActiveChecklistPasses() {
        ReminderDecision decision = service.remindOnNaturalComplete(new ChecklistReminderContext(SESSION_ID, EXECUTION_ID, null));

        assertEquals(ReminderDecision.Outcome.NO_ACTIVE_CHECKLIST, decision.outcome());
        assertFalse(decision.requiresAnotherRound());
        assertTrue(repository.findAllBySessionId(SESSION_ID).isEmpty());
    }

    private ChecklistPO activeRow(long id, long sessionId) {
        ChecklistPO po = new ChecklistPO();
        po.setId(id);
        po.setSessionId(sessionId);
        po.setTitle("直接插入的清单");
        po.setStatus(ChecklistStatus.ACTIVE.name());
        po.setRemindStatus(false);
        po.setProgressVersion(0L);
        po.setCreateAt(Instant.now());
        po.setUpdateAt(Instant.now());
        return po;
    }
}
