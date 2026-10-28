package com.summit.dp.checklist.infrastructure;

import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.support.ChecklistTestDatabase;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「删除不物理清除」必须配一个能读到历史的入口，否则保留现场只是数据库里的自我安慰。
 *
 * <p>审计口径与写入口一致：归属只认会话；与 findCurrent 的差别是它刻意不跳过 DELETED。</p>
 */
class ChecklistHistoryQueryTest {

    private static final long SESSION = 7801L;
    private static final long OTHER_SESSION = 7902L;

    private ChecklistTestDatabase fixture;
    private ChecklistService service;

    @BeforeEach
    void start() {
        fixture = ChecklistTestDatabase.start("checklist-history");
        service = fixture.service();
    }

    @AfterEach
    void close() {
        fixture.close();
    }

    @Test
    @DisplayName("展示口径与工作口径分离：current 看不到已删清单，latest 仍能取到供审计")
    void displayQueryKeepsDeletedHistoryWhileWorkQueryDropsIt() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION, null, "常驻", List.of("一步")));
        long checklistId = created.getChecklistId();
        service.delete(ChecklistCommand.delete(SESSION, checklistId));

        assertTrue(service.findCurrent(SESSION).isEmpty(), "工作口径：删除后不再视为可继续的清单");
        ChecklistVO displayed = service.findLatestForDisplay(SESSION).orElseThrow();
        assertEquals(checklistId, displayed.getChecklistId());
        assertEquals("DELETED", displayed.getStatus());
        assertEquals(1, displayed.getSteps().size());
    }

    @Test
    @DisplayName("latest 取最近一份：新建的清单覆盖旧历史，与后台任务胶囊的常驻语义一致")
    void displayQueryReturnsTheNewestChecklistOfTheSession() {
        ChecklistVO first = service.create(ChecklistCommand.create(SESSION, null, "第一份", List.of("一步")));
        service.delete(ChecklistCommand.delete(SESSION, first.getChecklistId()));
        ChecklistVO second = service.create(ChecklistCommand.create(SESSION, null, "第二份", List.of("一步")));

        assertEquals(second.getChecklistId(), service.findLatestForDisplay(SESSION).orElseThrow().getChecklistId());
        assertTrue(service.findLatestForDisplay(OTHER_SESSION).isEmpty(), "别的会话没有清单可看");
    }

    @Test
    @DisplayName("软删之后历史仍可按标识读到，且步骤证据与推进版本不被改写")
    void deletedHistoryStaysReadableWithItsEvidence() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION, null, "收尾",
                List.of("失败项", "跳过项", "收尾项")));
        long checklistId = created.getChecklistId();
        service.updateStep(ChecklistCommand.updateStep(SESSION, checklistId, created.getSteps().get(0).getStepId(), "FAILED"));
        service.updateStep(ChecklistCommand.updateStep(SESSION, checklistId, created.getSteps().get(1).getStepId(), "SKIPPED"));

        ChecklistVO deleted = service.delete(ChecklistCommand.delete(SESSION, checklistId, true));
        assertEquals("DELETED", deleted.getStatus());

        assertTrue(service.findCurrent(SESSION).isEmpty(), "删除后当前视图不再回看这份清单");
        ChecklistVO audited = service.findById(SESSION, checklistId).orElseThrow();
        assertEquals("DELETED", audited.getStatus());
        assertEquals(deleted.getProgressVersion(), audited.getProgressVersion());
        assertEquals(List.of("FAILED", "SKIPPED", "COMPLETED"), audited.getSteps().stream()
                .map(ChecklistVO.StepVO::getStatus).toList());
        assertEquals("收尾", audited.getTitle());
    }

    @Test
    @DisplayName("审计入口同样只认会话：别的会话查同一标识必须被拒绝而不是拿到空快照")
    void auditIsScopedToTheOwningSession() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION, null, "私有", List.of("一步")));
        long checklistId = created.getChecklistId();

        ClientException error = assertThrows(ClientException.class,
                () -> service.findById(OTHER_SESSION, checklistId));
        assertTrue(error.getMessage().contains("不属于当前会话"));
        assertEquals(checklistId, service.findById(SESSION, checklistId).orElseThrow().getChecklistId());
    }

    @Test
    @DisplayName("不存在的标识返回空，缺少标识直接报错，不能静默当成「没有清单」")
    void unknownOrMissingIdIsNotSilentlyResolved() {
        assertTrue(service.findById(SESSION, 404L).isEmpty());
        ClientException error = assertThrows(ClientException.class, () -> service.findById(SESSION, null));
        assertTrue(error.getMessage().contains("checklistId"));
    }

    @Test
    @DisplayName("审计是只读的：查一次不改状态、不推进版本")
    void auditingDoesNotMutateTheChecklist() {
        ChecklistVO created = service.create(ChecklistCommand.create(SESSION, null, "只读", List.of("一步", "两步")));
        ChecklistVO before = service.findById(SESSION, created.getChecklistId()).orElseThrow();
        ChecklistVO again = service.findById(SESSION, created.getChecklistId()).orElseThrow();

        assertEquals(before.getStatus(), again.getStatus());
        assertEquals(before.getProgressVersion(), again.getProgressVersion());
        assertEquals(before.getUpdateAt(), again.getUpdateAt());
        assertEquals("ACTIVE", service.findActive(SESSION).orElseThrow().getStatus());
    }
}
