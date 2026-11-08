package com.summit.dp.session;

import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.SessionTokenAuditItem;
import com.summit.dp.session.domain.model.TokenAuditCategory;
import com.summit.dp.session.domain.model.TokenAuditDisplayState;
import com.summit.dp.session.domain.model.TokenAuditGroupKind;
import com.summit.dp.session.domain.model.TokenAuditItemLevel;
import com.summit.dp.session.domain.model.TokenAuditPersistedState;
import com.summit.dp.session.domain.model.TokenAuditReconciler;
import com.summit.dp.session.domain.model.TokenAuditReconciler.GroupMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Measurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Result;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 快照聚合与明细行的纯单测（Pitest 扫描区 {@code com.summit.dp.session.domain.model}）。
 *
 * <p>覆盖四件事：{@code displayState} 四值派生、比率除零、覆盖裁决 {@code shouldReplace} 的乱序场景、
 * 失败不得覆盖成功快照。另含 U5 决策的<b>断言用例</b>：归因漂移是采集时算出并落库的独立诊断量，
 * 读库拿到的就是真值；「TOOL 行 − Σ分组」在库内恒为 0，因此不能退化成派生。</p>
 */
class SessionTokenAuditDomainTest {

    private static final long SESSION_ID = 1827364512093847552L;
    private static final Instant CAPTURED_AT = Instant.parse("2026-11-07T02:15:33.412Z");
    /** 新口径：工具视图为「结果消息 + 框架」，不含参数。 */
    private static final int TOOL_DOCUMENT = 63614;
    private static final int ARGUMENTS = 5900;

    @Test
    @DisplayName("displayState：无快照=NOT_COLLECTED，失败=FAILED，等值=COLLECTED，不等=CAPTURING")
    void displayStateHasFourValues() {
        SessionTokenAudit collected = snapshot(148200, 200000);

        assertEquals(TokenAuditDisplayState.COLLECTED, collected.resolveDisplayState(148200L));
        assertEquals(TokenAuditDisplayState.CAPTURING, collected.resolveDisplayState(150000L));
        assertEquals(TokenAuditDisplayState.CAPTURING, collected.resolveDisplayState(140000L));
        assertEquals(TokenAuditDisplayState.COLLECTED, collected.resolveDisplayState(null),
                "实时总量未知时不能凭空说「在采集」，快照本身是唯一可信事实");

        SessionTokenAudit failed = SessionTokenAudit.failure(SESSION_ID, 1L, "boom", CAPTURED_AT);
        assertEquals(TokenAuditDisplayState.FAILED, failed.resolveDisplayState(1L),
                "FAILED 优先于任何数值判定");
        assertEquals(TokenAuditDisplayState.FAILED, failed.resolveDisplayState(null));
    }

    @Test
    @DisplayName("driftTokens 与 ratio：缺失一侧返回 null，上限为 0 不除零")
    void driftAndRatioHandleMissingValues() {
        SessionTokenAudit audit = snapshot(148200, 200000);

        assertEquals(1800, audit.driftTokens(150000L));
        assertEquals(-8200, audit.driftTokens(140000L));
        assertNull(audit.driftTokens(null), "实时总量缺失时差值为 null（0 会被读成「对得齐」）");
        assertEquals(0.741, audit.ratio(), 1.0e-9);
        assertNull(snapshot(148200, 0).ratio(), "上限未知或为 0 时必须为 null");
    }

    @Test
    @DisplayName("明细行 ratioOf：父级为 0 / null / 负数时返回 null，不产生 NaN")
    void itemRatioOfHandlesZeroParent() {
        SessionTokenAuditItem item = SessionTokenAuditItem.toolItem("search_web", 3, 9420, 2100, 8700, 1);

        assertNull(item.ratioOf(null));
        assertNull(item.ratioOf(0));
        assertNull(item.ratioOf(-5));
        assertNotNull(item.ratioOf(24200));
        assertEquals(9420.0 / 24200.0, item.ratioOf(24200), 1.0e-12);
    }

    @Test
    @DisplayName("shouldReplace：更晚覆盖、更早拒绝、同刻按执行 id 裁决")
    void shouldReplaceFollowsOrdering() {
        SessionTokenAudit current = snapshot(148200, 200000, 2L, CAPTURED_AT);

        assertTrue(current.shouldReplace(CAPTURED_AT.plusMillis(1), 1L), "更晚的采集必须覆盖");
        assertFalse(current.shouldReplace(CAPTURED_AT.minusMillis(1), 99L), "更早的采集不得覆盖");
        assertTrue(current.shouldReplace(CAPTURED_AT, 3L), "同刻且执行 id 更大时覆盖");
        assertFalse(current.shouldReplace(CAPTURED_AT, 2L), "同刻同 id 幂等，不覆盖");
        assertFalse(current.shouldReplace(CAPTURED_AT, 1L), "同刻且执行 id 更小时不覆盖");
        assertFalse(current.shouldReplace(null, 1L), "采集时刻缺失直接拒绝");
        assertFalse(current.shouldReplace(CAPTURED_AT, null), "新采集没有执行 id 时同刻不覆盖");
    }

    @Test
    @DisplayName("shouldReplace：旧快照缺采集时刻或执行 id 时允许被替换")
    void shouldReplaceHandlesLegacyRows() {
        SessionTokenAudit restored = SessionTokenAudit.restore(SESSION_ID, null,
                TokenAuditPersistedState.COLLECTED, 100, 200, 90, 10, 0, null, null, null, null, null, List.of());

        assertTrue(restored.shouldReplace(CAPTURED_AT, null), "旧行没有采集时刻时必须能升级");
        assertTrue(restored.shouldReplace(CAPTURED_AT, 7L));
    }

    @Test
    @DisplayName("失败不得覆盖已有 COLLECTED 快照")
    void failureNeverOverwritesCollected() {
        SessionTokenAudit collected = snapshot(148200, 200000);

        collected.changeFailed("框架审计失败");

        assertEquals(TokenAuditPersistedState.COLLECTED, collected.getState());
        assertEquals(148200, collected.getTotalTokens());
        assertNull(collected.getFailReason(), "成功快照不得被写进失败原因");
        assertEquals(9, collected.getItems().size(), "明细行必须原样保留（4 消息 + 3 分组 + 2 工具名）");
    }

    @Test
    @DisplayName("无快照时失败落 FAILED：数值清空、原因截断到 512 字符且不截半个汉字")
    void failureTruncatesReasonByCharacters() {
        String chinese = "错".repeat(600);
        SessionTokenAudit failed = SessionTokenAudit.failure(SESSION_ID, 9L, chinese, CAPTURED_AT);

        assertEquals(TokenAuditPersistedState.FAILED, failed.getState());
        assertNull(failed.getTotalTokens(), "失败就是「不知道」，数值必须留空");
        assertNull(failed.getMessagesTokens());
        assertEquals(SessionTokenAudit.MAX_FAIL_REASON_LENGTH, failed.getFailReason().length(),
                "必须按字符截断到 512（按字节截会切出半个汉字）");
        assertTrue(failed.getFailReason().chars().allMatch(code -> code == '错'),
                "截断后不得出现替换字符");
        assertTrue(failed.getItems().isEmpty());

        SessionTokenAudit blank = SessionTokenAudit.failure(SESSION_ID, 9L, "  ", CAPTURED_AT);
        assertEquals("token 审计采集失败", blank.getFailReason(), "空原因必须走兜底文案");
    }

    @Test
    @DisplayName("工具定义两项随快照落库读回一致；未知保持 null，失败态一律清空")
    void toolDefinitionTokensSurviveRoundTrip() {
        Result result = TokenAuditReconciler.reconcile(new Measurement(12300, 18450, 39000, 63614,
                5900, 148200, 200000, List.of(), 8200, 3100));
        SessionTokenAudit captured = SessionTokenAudit.capture(SESSION_ID, 1L, result, CAPTURED_AT);

        assertEquals(8200, captured.getToolDefinitionTokens());
        assertEquals(3100, captured.getMcpToolDefinitionTokens());
        assertEquals(148200 - result.messagesTokens() - 8200 - 3100,
                captured.framingResidualTokens(), "残差由请求开销减去两项工具定义现算");

        // 模拟「读库」：只带库里的列，不带任何采集期中间量。
        SessionTokenAudit reloaded = SessionTokenAudit.restore(SESSION_ID, 1L, captured.getState(),
                captured.getTotalTokens(), captured.getMaxTokens(), captured.getMessagesTokens(),
                captured.getRequestOverheadTokens(), captured.getOverlapTokens(),
                captured.getToolGroupingDrift(), captured.getToolDefinitionTokens(),
                captured.getMcpToolDefinitionTokens(), captured.getCapturedAt(),
                captured.getFailReason(), captured.getItems());

        assertEquals(8200, reloaded.getToolDefinitionTokens(), "读回值必须等于采集值");
        assertEquals(3100, reloaded.getMcpToolDefinitionTokens());
        assertEquals(captured.framingResidualTokens(), reloaded.framingResidualTokens(),
                "残差是派生值，读回后必须与采集期算出的完全相同");

        // 未知 → null 传递到读回，不得被抹成 0。
        SessionTokenAudit unknown = SessionTokenAudit.capture(SESSION_ID, 1L,
                TokenAuditReconciler.reconcile(measurement()), CAPTURED_AT);
        assertNull(unknown.getToolDefinitionTokens(), "未知必须是 null 而不是 0");
        assertNull(unknown.getMcpToolDefinitionTokens());
        assertNull(unknown.framingResidualTokens(), "两项未知时残差也必须为 null");

        // 失败态把上一轮的两项值一并清空（残差不落库，自然为 null）。
        SessionTokenAudit failed = SessionTokenAudit.restore(SESSION_ID, 1L,
                TokenAuditPersistedState.FAILED, null, null, null, null, null, null, 8200, 3100,
                CAPTURED_AT, "先失败", List.of());
        failed.changeFailed("再失败一次");
        assertNull(failed.getToolDefinitionTokens(), "失败态不得保留上一轮的工具定义值");
        assertNull(failed.getMcpToolDefinitionTokens());
        assertNull(failed.framingResidualTokens());
    }

    @Test
    @DisplayName("U5：漂移随采集落库，读回是真值；「TOOL 行 − Σ分组」在库内恒为 0，故不能靠派生")
    void toolGroupingDriftIsPersistedNotDerived() {
        Result result = TokenAuditReconciler.reconcile(measurement());
        SessionTokenAudit captured = SessionTokenAudit.capture(SESSION_ID, 1L, result, CAPTURED_AT);

        assertEquals(-6, captured.getToolGroupingDrift(), "采集时把框架残差存进聚合");

        // 模拟「读库」：只有落库的数值，没有采集期的中间量。
        SessionTokenAudit reloaded = SessionTokenAudit.restore(SESSION_ID, 1L, captured.getState(),
                captured.getTotalTokens(), captured.getMaxTokens(), captured.getMessagesTokens(),
                captured.getRequestOverheadTokens(), captured.getOverlapTokens(),
                captured.getToolGroupingDrift(), captured.getToolDefinitionTokens(),
                captured.getMcpToolDefinitionTokens(), captured.getCapturedAt(),
                captured.getFailReason(), captured.getItems());

        assertEquals(-6, reloaded.getToolGroupingDrift(), "读回值必须等于采集值（已落库，不是 0）");
        int toolRow = captured.messagesOf(TokenAuditCategory.TOOL).resultTokens();
        int groupSum = reloaded.toolGroups().stream()
                .mapToInt(SessionTokenAuditItem::resultTokens).sum();
        assertEquals(groupSum, toolRow, "恒等式 3：TOOL 行必须等于分组之和");
        assertEquals(0, toolRow - groupSum,
                "「TOOL 行 − Σ分组」在库内恒为 0 —— 这就是为什么该值必须单独落库而不能派生");
    }

    @Test
    @DisplayName("U5：无工具分组时漂移为 0，不得把 TOOL 行整份当成漂移")
    void driftIsZeroWithoutGroups() {
        Result result = TokenAuditReconciler.reconcile(
                new Measurement(100, 200, 300, 73100, 6400, 73700, 0, List.of()));
        SessionTokenAudit audit = SessionTokenAudit.capture(SESSION_ID, 1L, result, CAPTURED_AT);

        assertEquals(0, audit.getToolGroupingDrift());
        assertEquals(0, audit.toolTokens(), "没有分组行时 TOOL 下钻合计为 0");
        assertEquals(73100, audit.messagesOf(TokenAuditCategory.TOOL).resultTokens(),
                "TOOL 行仍保留框架原值");
    }

    @Test
    @DisplayName("轨迹与分组查询：toolGroups 按 sortOrder 升序，getItems 只读")
    void groupsAndItemsAreReadOnly() {
        SessionTokenAudit audit = snapshot(148200, 200000);

        assertEquals(List.of(TokenAuditGroupKind.MCP, TokenAuditGroupKind.SKILL,
                        TokenAuditGroupKind.ORDINARY),
                audit.toolGroups().stream().map(SessionTokenAuditItem::getGroupKind).toList());
        assertEquals(2, audit.toolItems().size());
        assertEquals(63620, audit.toolTokens(), "分组展示值之和");
        assertThrows(UnsupportedOperationException.class,
                () -> audit.getItems().add(null), "getItems 必须返回不可变副本");
    }

    @Test
    @DisplayName("覆盖裁决补充：旧行执行 id 缺失、采集时刻相同时允许被替换；失败态可再次失败并清空明细")
    void shouldReplaceLegacyAndRepeatedFailure() {
        SessionTokenAudit noExecution = SessionTokenAudit.restore(SESSION_ID, null,
                TokenAuditPersistedState.COLLECTED, 100, 200, 90, 10, 0, null, null, null, CAPTURED_AT, null,
                List.of(SessionTokenAuditItem.message(TokenAuditCategory.SYSTEM, 90, 0, 1)));
        assertTrue(noExecution.shouldReplace(CAPTURED_AT, 5L),
                "同刻但旧行没有执行 id 时必须能被替换（否则快照永远停在旧数据）");

        SessionTokenAudit failed = SessionTokenAudit.restore(SESSION_ID, 1L,
                TokenAuditPersistedState.FAILED, null, null, null, null, null, null, null, null, CAPTURED_AT, "先失败",
                List.of(SessionTokenAuditItem.message(TokenAuditCategory.SYSTEM, 90, 0, 1)));
        failed.changeFailed("再失败一次");
        assertTrue(failed.getItems().isEmpty(), "失败态再次失败必须清空残留明细");
        assertEquals("再失败一次", failed.getFailReason());
    }

    @Test
    @DisplayName("resolveDisplayState：总量缺失但状态不是 FAILED 时为 NOT_COLLECTED")
    void displayStateNotCollectedWhenTotalsMissing() {
        SessionTokenAudit missingTotals = SessionTokenAudit.restore(SESSION_ID, 1L,
                TokenAuditPersistedState.COLLECTED, null, 200000, null, null, null, null, null, null, CAPTURED_AT, null,
                List.of());

        assertEquals(TokenAuditDisplayState.NOT_COLLECTED, missingTotals.resolveDisplayState(120L),
                "总量未知时不能报 COLLECTED/CAPTURING");
        assertNull(missingTotals.ratio(), "总量缺失时比率必须为 null");
        assertNull(missingTotals.getTotalTokens());
    }

    @Test
    @DisplayName("ratio / toMaxTokens 边界：上限恰为 0 时比率为 null，且落库写成 null")
    void ratioBoundaryOnZeroMaxTokens() {
        SessionTokenAudit zeroMax = SessionTokenAudit.restore(SESSION_ID, 1L,
                TokenAuditPersistedState.COLLECTED, 100, 0, 90, 10, 0, null, null, null, CAPTURED_AT, null, List.of());
        assertNull(zeroMax.ratio(), "上限恰为 0 时不除零");

        SessionTokenAudit negativeMax = SessionTokenAudit.restore(SESSION_ID, 1L,
                TokenAuditPersistedState.COLLECTED, 100, -1, 90, 10, 0, null, null, null, CAPTURED_AT, null, List.of());
        assertNull(negativeMax.ratio());

        SessionTokenAudit captured = SessionTokenAudit.capture(SESSION_ID, 1L,
                new Result(100, 0, 90, 10, 0, 0, List.of()), CAPTURED_AT);
        assertNull(captured.getMaxTokens(), "框架没给上限（0）时必须落 null 而不是 0");
    }

    @Test
    @DisplayName("toolGroupingDrift 读回真值：落库值不必等于「TOOL 行 − 分组」，它是独立诊断量")
    void toolGroupingDriftReportsPersistedValue() {
        SessionTokenAudit inconsistent = SessionTokenAudit.restore(SESSION_ID, 1L,
                TokenAuditPersistedState.COLLECTED, 100, 200, 190, 0, 0, 10, null, null, CAPTURED_AT, null, List.of(
                SessionTokenAuditItem.message(TokenAuditCategory.TOOL, 100, 0, 4),
                SessionTokenAuditItem.toolGroup(TokenAuditGroupKind.MCP, 1, 90, 0, 80, 1)));

        assertEquals(10, inconsistent.getToolGroupingDrift(),
                "读回的是库里的诊断值，不是由 TOOL 行与分组相减重新算出来的");
    }

    @Test
    @DisplayName("分组与工具名查询按 sortOrder 升序，与入库顺序无关")
    void itemsSortedBySortOrder() {
        SessionTokenAudit unsorted = SessionTokenAudit.restore(SESSION_ID, 1L,
                TokenAuditPersistedState.COLLECTED, 100, 200, 90, 10, 0, null, null, null, CAPTURED_AT, null, List.of(
                SessionTokenAuditItem.toolGroup(TokenAuditGroupKind.ORDINARY, 2, 30, 0, 20, 3),
                SessionTokenAuditItem.toolGroup(TokenAuditGroupKind.MCP, 1, 60, 0, 50, 1),
                SessionTokenAuditItem.toolGroup(TokenAuditGroupKind.SKILL, 1, 10, 0, 5, 2)));

        assertEquals(List.of(TokenAuditGroupKind.MCP, TokenAuditGroupKind.SKILL,
                        TokenAuditGroupKind.ORDINARY),
                unsorted.toolGroups().stream().map(SessionTokenAuditItem::getGroupKind).toList(),
                "查询必须按 sortOrder 升序重排，不能依赖入参顺序");
    }

    @Test
    @DisplayName("失败原因边界：恰为 512 字符不截断，513 字符截到 512")
    void failReasonBoundary() {
        String exact = "错".repeat(SessionTokenAudit.MAX_FAIL_REASON_LENGTH);
        String overflow = exact + "错";

        assertEquals(exact.length(),
                SessionTokenAudit.failure(SESSION_ID, 1L, exact, CAPTURED_AT).getFailReason().length());
        assertEquals(SessionTokenAudit.MAX_FAIL_REASON_LENGTH,
                SessionTokenAudit.failure(SESSION_ID, 1L, overflow, CAPTURED_AT).getFailReason()
                        .length());
    }

    @Test
    @DisplayName("工具名归一：空白归到 unknown_tool，恰为 128 字符不截断，129 截断")
    void toolNameBoundary() {
        String exact = "a".repeat(TokenAuditReconciler.MAX_TOOL_NAME_LENGTH);
        String overflow = exact + "b";

        assertEquals(TokenAuditReconciler.UNKNOWN_TOOL_NAME,
                SessionTokenAuditItem.toolItem("   ", 1, 1, 0, 0, 1).getToolName());
        assertEquals(exact, SessionTokenAuditItem.toolItem(exact, 1, 1, 0, 0, 1).getToolName());
        assertEquals(exact, SessionTokenAuditItem.toolItem(overflow, 1, 1, 0, 0, 1).getToolName(),
                "超长工具名必须截断到列宽");
        assertNotNull(SessionTokenAuditItem.restore(1L, TokenAuditItemLevel.MESSAGE,
                TokenAuditCategory.SYSTEM, null, null, 0, 1, 0, 0, 1), "restore 必须返回实体");
    }

    @Test
    @DisplayName("明细行校验：层级与字段错配、负数、空分类一律拒绝")
    void itemValidationRejectsInconsistentRows() {
        assertThrows(ClientException.class, () -> SessionTokenAuditItem.message(null, 1, 0, 1));
        assertThrows(ClientException.class, () -> SessionTokenAuditItem.message(
                TokenAuditCategory.SYSTEM, -1, 0, 1));
        assertThrows(ClientException.class, () -> SessionTokenAuditItem.toolGroup(
                null, 1, 1, 0, 0, 1));
        assertThrows(ClientException.class, () -> SessionTokenAuditItem.toolItem(
                "t", -1, 1, 0, 0, 1));
        assertThrows(ClientException.class, () -> SessionTokenAuditItem.restore(1L,
                TokenAuditItemLevel.MESSAGE, TokenAuditCategory.SYSTEM, TokenAuditGroupKind.MCP,
                null, 0, 1, 0, 0, 1));
        assertThrows(ClientException.class, () -> SessionTokenAudit.restore(null, 1L,
                TokenAuditPersistedState.COLLECTED, 1, 1, 1, 0, 0, 0, null, null, CAPTURED_AT, null, List.of()),
                "快照必须归属一个会话");
        assertThrows(ClientException.class,
                () -> SessionTokenAudit.capture(SESSION_ID, 1L, null, CAPTURED_AT));
    }

    private static SessionTokenAudit snapshot(int totalTokens, int maxTokens) {
        return snapshot(totalTokens, maxTokens, 1L, CAPTURED_AT);
    }

    private static SessionTokenAudit snapshot(int totalTokens, int maxTokens, Long executionId,
                                              Instant capturedAt) {
        Result result = TokenAuditReconciler.reconcile(measurement());
        return SessionTokenAudit.capture(SESSION_ID, executionId,
                new Result(totalTokens, maxTokens, result.messagesTokens(),
                        totalTokens - result.messagesTokens(), result.overlapTokens(),
                        result.toolGroupingDrift(), result.items()),
                capturedAt);
    }

    /** 三个分组：MCP 34700、SKILL 14200、普通工具 14720（search_web 9420 + read_file 5300）。 */
    private static Measurement measurement() {
        int ordinary = 9420 + 5300;
        return new Measurement(12300, 18450, 39000, TOOL_DOCUMENT, ARGUMENTS, 148200, 200000,
                List.of(new GroupMeasurement(TokenAuditGroupKind.MCP, 34700, 2100, 33000, 12, List.of()),
                        new GroupMeasurement(TokenAuditGroupKind.SKILL, 14200, 800, 13000, 3,
                                List.of()),
                        new GroupMeasurement(TokenAuditGroupKind.ORDINARY, ordinary, 3000,
                                ordinary - 560, 5, List.of(
                                new TokenAuditReconciler.ItemMeasurement("search_web", 9420, 2100,
                                        8700, 3),
                                new TokenAuditReconciler.ItemMeasurement("read_file", 5300, 900,
                                        4600, 2)))));
    }
}
