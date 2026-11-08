package com.summit.dp.session;

import com.summit.dp.session.domain.model.SessionTokenAuditItem;
import com.summit.dp.session.domain.model.TokenAuditCategory;
import com.summit.dp.session.domain.model.TokenAuditGroupKind;
import com.summit.dp.session.domain.model.TokenAuditItemLevel;
import com.summit.dp.session.domain.model.TokenAuditReconciler;
import com.summit.dp.session.domain.model.TokenAuditReconciler.GroupMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.ItemMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Measurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Result;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 口径唯一真源的纯单测（Pitest 扫描区 {@code com.summit.dp.session.domain.model}）。
 *
 * <p><b>数值全部按框架 {@code d32ff83} 之后的新口径自洽构造</b>：{@code ToolElement.totalTokens}
 * 与 {@code ToolAuditDocument.toolTokens} 是「结果消息 + 结果消息框架」，<b>不含</b>工具调用参数；
 * 参数只作归因说明。因此本类<b>不出现任何「总量 − 参数」的期望值</b> ——
 * 一旦有人在生产代码里把减法加回来，第 4、5 条用例必然变红。</p>
 *
 * <p>四条恒等式是唯一硬约束：</p>
 * <ol>
 *   <li>{@code messagesTokens = SYSTEM + USER + AI + TOOL}</li>
 *   <li>{@code totalTokens = messagesTokens + requestOverheadTokens}（减法得出）</li>
 *   <li>{@code TOOL = Σ(工具分组)}</li>
 *   <li>{@code 普通工具分组 = Σ(工具名)}</li>
 * </ol>
 */
class TokenAuditReconcilerTest {

    private static final int SYSTEM = 12300;
    private static final int USER = 18450;
    private static final int AI = 39000;
    private static final int ARGUMENTS = 5900;
    private static final int MCP_TOKENS = 34700;
    private static final int SKILL_TOKENS = 14200;
    private static final int SEARCH_WEB = 9420;
    private static final int READ_FILE = 5300;
    /** 三个分组独立测量各带一个 primer，故框架工具总量比「分组之和」小 6。 */
    private static final int TOOL_DOCUMENT = MCP_TOKENS + SKILL_TOKENS + SEARCH_WEB + READ_FILE - 6;
    private static final int ORDINARY_TOKENS = SEARCH_WEB + READ_FILE;
    private static final int TOOL = MCP_TOKENS + SKILL_TOKENS + ORDINARY_TOKENS;
    private static final int MESSAGES = SYSTEM + USER + AI + TOOL;
    private static final int LIVE_TOTAL = 142850;
    private static final int MAX_TOKENS = 200000;
    /** 随请求下发的工具定义 token（框架 {@code OtherTokens}）。 */
    private static final int TOOL_DEFINITION = 8200;
    private static final int MCP_TOOL_DEFINITION = 3100;

    @Test
    @DisplayName("恒等式 1：四类分项之和等于 messagesTokens，且四行顺序固定")
    void messagesEqualSumOfFourCategories() {
        Result result = TokenAuditReconciler.reconcile(measurementWithGroups());

        assertEquals(MESSAGES, result.messagesTokens(), "四类之和必须等于 messagesTokens");
        assertEquals(List.of(TokenAuditCategory.SYSTEM, TokenAuditCategory.USER, TokenAuditCategory.AI,
                        TokenAuditCategory.TOOL),
                messageRows(result).stream().map(SessionTokenAuditItem::getCategory).toList(),
                "消息行顺序必须是 SYSTEM/USER/AI/TOOL");
        assertEquals(List.of(1, 2, 3, 4),
                messageRows(result).stream().map(SessionTokenAuditItem::getSortOrder).toList());
        int sum = messageRows(result).stream().mapToInt(SessionTokenAuditItem::resultTokens).sum();
        assertEquals(MESSAGES, sum, "按展示值求和同样必须等于 messagesTokens");
    }

    @Test
    @DisplayName("恒等式 2：请求开销由减法得出，总量 = 消息 + 开销")
    void requestOverheadComesFromSubtraction() {
        Result result = TokenAuditReconciler.reconcile(measurementWithGroups());

        assertEquals(LIVE_TOTAL, result.totalTokens());
        assertEquals(LIVE_TOTAL - MESSAGES, result.requestOverheadTokens(),
                "请求开销必须是 total − messages，不允许独立估算");
        assertEquals(result.totalTokens(),
                result.messagesTokens() + result.requestOverheadTokens(),
                "总量必须恰等于消息之和加请求开销");
        assertTrue(result.requestOverheadTokens() > 0, "含工具定义时开销为正");
    }

    @Test
    @DisplayName("恒等式 3：TOOL 行展示值等于各分组展示值之和，漂移只反映分组 primer")
    void toolEqualsSumOfGroups() {
        Result result = TokenAuditReconciler.reconcile(measurementWithGroups());

        int groupSum = result.items().stream()
                .filter(item -> item.getLevel() == TokenAuditItemLevel.TOOL_GROUP)
                .mapToInt(SessionTokenAuditItem::resultTokens)
                .sum();
        assertEquals(TOOL, groupSum, "三个分组展示值之和必须是 TOOL 总量");
        assertEquals(TOOL, toolRow(result).resultTokens(), "TOOL 行展示值必须等于分组之和");
        assertEquals(TOOL_DOCUMENT - TOOL, result.toolGroupingDrift(),
                "漂移 = 框架工具总量 − 分组之和（本例为 −6）");
        assertEquals(-6, result.toolGroupingDrift());
    }

    @Test
    @DisplayName("恒等式 4：普通工具分组等于各工具名之和，工具名行按展示值降序")
    void ordinaryGroupEqualsSumOfToolNames() {
        Result result = TokenAuditReconciler.reconcile(measurementWithGroups());

        SessionTokenAuditItem ordinary = result.items().stream()
                .filter(item -> item.getLevel() == TokenAuditItemLevel.TOOL_GROUP)
                .filter(item -> item.getGroupKind() == TokenAuditGroupKind.ORDINARY)
                .findFirst()
                .orElseThrow();
        List<SessionTokenAuditItem> items = result.items().stream()
                .filter(item -> item.getLevel() == TokenAuditItemLevel.TOOL_ITEM)
                .toList();
        assertEquals(ORDINARY_TOKENS, ordinary.resultTokens(), "分组值必须等于工具名之和");
        assertEquals(ORDINARY_TOKENS, items.stream().mapToInt(SessionTokenAuditItem::resultTokens).sum());
        assertEquals(List.of("search_web", "read_file"),
                items.stream().map(SessionTokenAuditItem::getToolName).toList(),
                "工具名必须按展示值降序，同值按名字升序");
        assertEquals(List.of(1, 2), items.stream().map(SessionTokenAuditItem::getSortOrder).toList());
        assertEquals(ARGUMENTS, result.overlapTokens(), "参数合计只作说明字段下发");
    }

    @Test
    @DisplayName("新口径回归：TOOL 行直接用框架总量，绝不减参数（减了会凭空少 6400）")
    void toolRowNeverSubtractsArguments() {
        Measurement noGroups = new Measurement(SYSTEM, USER, AI, 73100, 6400, LIVE_TOTAL, MAX_TOKENS,
                List.of());
        Result result = TokenAuditReconciler.reconcile(noGroups);

        assertEquals(73100, toolRow(result).resultTokens(),
                "无分组时 TOOL 行必须原样等于框架总量；等于 66700 说明又做了一次减法");
        assertEquals(73100, toolRow(result).getTotalTokens(),
                "落库值同样必须是框架原值，展示不再二次扣减");
        assertEquals(0, result.toolGroupingDrift(), "无分组时漂移为 0");
        assertEquals(SYSTEM + USER + AI + 73100, result.messagesTokens());
    }

    @Test
    @DisplayName("新口径回归：参数大于结果不得抛错（两者已无包含关系）")
    void argumentsMayExceedTotal() {
        GroupMeasurement group = new GroupMeasurement(TokenAuditGroupKind.ORDINARY,
                1000, 5000, 900, 1,
                List.of(new ItemMeasurement("read_file", 1000, 5000, 900, 1)));
        Measurement measurement = new Measurement(0, 0, 7000, 1000, 5000, 8000, 0, List.of(group));

        Result result = TokenAuditReconciler.reconcile(measurement);

        SessionTokenAuditItem item = result.items().stream()
                .filter(row -> row.getLevel() == TokenAuditItemLevel.TOOL_ITEM)
                .findFirst()
                .orElseThrow();
        assertEquals(1000, item.resultTokens(), "展示值就是框架总量，参数不参与减法");
        assertEquals(5000, item.getArgumentTokens(), "参数照原值保留（只读归因）");
        assertEquals(1000, toolRow(result).resultTokens());
    }

    @Test
    @DisplayName("总量缺失退化为「请求开销 = 0」，绝不产生巨大负残差")
    void missingTotalDegradesToZeroOverhead() {
        Measurement unknownTotal = new Measurement(SYSTEM, USER, AI, TOOL_DOCUMENT, ARGUMENTS, 0,
                MAX_TOKENS, groups());

        Result result = TokenAuditReconciler.reconcile(unknownTotal);

        assertEquals(MESSAGES, result.totalTokens(), "没给总量时总量退化为消息之和");
        assertEquals(0, result.requestOverheadTokens(), "退化后请求开销必须是 0 而不是负残差");
        assertTrue(result.requestOverheadTokens() >= 0);
    }

    @Test
    @DisplayName("上限未知时 Result.maxTokens 为 0，比率交给上层置空")
    void unknownMaxTokensStaysZero() {
        Measurement noMax = new Measurement(SYSTEM, USER, AI, TOOL_DOCUMENT, ARGUMENTS, LIVE_TOTAL, 0,
                groups());

        assertEquals(0, TokenAuditReconciler.reconcile(noMax).maxTokens());
    }

    @Test
    @DisplayName("恒等式 5：请求开销 = 工具定义 + MCP 工具定义 + 请求框架残差（残差由减法派生）")
    void requestOverheadSplitsIntoDefinitionsPlusResidual() {
        Result result = TokenAuditReconciler.reconcile(measurementWithDefinitions());

        assertEquals(TOOL_DEFINITION, result.toolDefinitionTokens());
        assertEquals(MCP_TOOL_DEFINITION, result.mcpToolDefinitionTokens());
        assertEquals(LIVE_TOTAL - MESSAGES - TOOL_DEFINITION - MCP_TOOL_DEFINITION,
                result.framingResidualTokens(), "残差必须是「请求开销 − 两项工具定义」的减法结果");
        assertEquals(result.requestOverheadTokens(),
                result.toolDefinitionTokens() + result.mcpToolDefinitionTokens()
                        + result.framingResidualTokens(),
                "三项之和必须精确回到请求开销");
        // 恒等式 2 仍然独立成立：总量 = 消息 + 请求开销，工具定义不重复计入消息。
        assertEquals(result.totalTokens(),
                result.messagesTokens() + result.requestOverheadTokens());
        assertEquals(MESSAGES, result.messagesTokens(),
                "工具定义属于非消息开销，绝不能进 messagesTokens");
    }

    @Test
    @DisplayName("恒等式 5：任一项工具定义为未知（null）时残差必须为 null，不得拿半份数据凑数")
    void framingResidualIsUnknownWhenEitherDefinitionUnknown() {
        Result bothUnknown = TokenAuditReconciler.reconcile(measurementWithGroups());
        assertNull(bothUnknown.toolDefinitionTokens());
        assertNull(bothUnknown.mcpToolDefinitionTokens());
        assertNull(bothUnknown.framingResidualTokens(), "两项都未知时残差必须为 null，不能是 0");

        Result onlyTools = TokenAuditReconciler.reconcile(new Measurement(SYSTEM, USER, AI,
                TOOL_DOCUMENT, ARGUMENTS, LIVE_TOTAL, MAX_TOKENS, groups(), TOOL_DEFINITION, null));
        assertEquals(TOOL_DEFINITION, onlyTools.toolDefinitionTokens());
        assertNull(onlyTools.mcpToolDefinitionTokens());
        assertNull(onlyTools.framingResidualTokens(), "MCP 未知时同样整体未知");

        Result onlyMcp = TokenAuditReconciler.reconcile(new Measurement(SYSTEM, USER, AI,
                TOOL_DOCUMENT, ARGUMENTS, LIVE_TOTAL, MAX_TOKENS, groups(), null,
                MCP_TOOL_DEFINITION));
        assertNull(onlyMcp.toolDefinitionTokens());
        assertNull(onlyMcp.framingResidualTokens());
    }

    @Test
    @DisplayName("工具定义已知时不得为负；已知为 0 是合法值（真的没有工具定义）")
    void toolDefinitionRejectsNegativeButAcceptsZero() {
        assertThrows(ClientException.class, () -> new Measurement(0, 0, 0, 0, 0, 0, 0, List.of(),
                -1, null));
        assertThrows(ClientException.class, () -> new Measurement(0, 0, 0, 0, 0, 0, 0, List.of(),
                null, -1));
        assertThrows(ClientException.class, () -> new Result(0, 0, 0, 0, 0, 0, -1, 0, 0, List.of()));
        assertThrows(ClientException.class, () -> new Result(0, 0, 0, 0, 0, 0, 0, -1, 0, List.of()));

        Result zero = TokenAuditReconciler.reconcile(new Measurement(0, 0, 0, 0, 0, 0, 0, List.of(),
                0, 0));
        assertEquals(0, zero.toolDefinitionTokens(), "0 是「确实没有工具定义」，必须与未知区分开");
        assertEquals(0, zero.mcpToolDefinitionTokens());
        assertEquals(0, zero.framingResidualTokens(), "请求开销 0 − 0 − 0 = 0");
    }

    @Test
    @DisplayName("恒等式 5 的残差可为负（扣不干净时如实为负），且分解校验仍然通过")
    void framingResidualCanBeNegative() {
        // 只有系统提示词 500 token，总量 1500 → 请求开销 1000；
        // 而两项工具定义合计 11300，残差必然为负（−10300）。负残差是真实存在的事实，不许掰成 0。
        Measurement tight = new Measurement(500, 0, 0, 0, 0, 1500, 0, List.of(),
                TOOL_DEFINITION, MCP_TOOL_DEFINITION);
        Result result = TokenAuditReconciler.reconcile(tight);

        assertEquals(500, result.messagesTokens());
        assertEquals(1000, result.requestOverheadTokens());
        assertEquals(1000 - TOOL_DEFINITION - MCP_TOOL_DEFINITION, result.framingResidualTokens());
        assertTrue(result.framingResidualTokens() < 0, "残差是减法派生的，允许为负");
    }

    @Test
    @DisplayName("分解校验：三项之和对不上请求开销时抛 ClientException 并指出差额")
    void decompositionCheckReportsDifference() {
        assertEquals(18550, 8200 + 3100 + 7250, "先确认示例数字自洽");
        assertDoesNotThrow(() -> TokenAuditReconciler.verifyDecomposition(18550, 8200, 3100, 7250));

        ClientException bothUnknown = assertThrows(ClientException.class,
                () -> TokenAuditReconciler.verifyDecomposition(18550, 8200, 3100, 7000));
        assertTrue(bothUnknown.getMessage().contains("差额 250"),
                "异常必须指出差额，便于定位是哪个环节算歪了: " + bothUnknown.getMessage());

        // 任一未知时不校验（未知不是「对不上」）。
        assertDoesNotThrow(() -> TokenAuditReconciler.verifyDecomposition(18550, null, 3100, 7250));
        assertDoesNotThrow(() -> TokenAuditReconciler.verifyDecomposition(18550, 8200, null, 7250));
        assertDoesNotThrow(() -> TokenAuditReconciler.verifyDecomposition(18550, 8200, 3100, null));
    }

    @Test
    @DisplayName("空输入与非法输入：null 抛错、负数抛错、空分组正常换算")
    void invalidInputRejected() {
        assertThrows(ClientException.class, () -> TokenAuditReconciler.reconcile(null));
        assertThrows(ClientException.class, () -> new Measurement(-1, 0, 0, 0, 0, 0, 0, List.of()));
        assertThrows(ClientException.class, () -> new Measurement(0, -1, 0, 0, 0, 0, 0, List.of()));
        assertThrows(ClientException.class, () -> new Measurement(0, 0, -1, 0, 0, 0, 0, List.of()));
        assertThrows(ClientException.class, () -> new Measurement(0, 0, 0, -1, 0, 0, 0, List.of()));
        assertThrows(ClientException.class, () -> new Measurement(0, 0, 0, 0, -1, 0, 0, List.of()));
        assertThrows(ClientException.class, () -> new Measurement(0, 0, 0, 0, 0, -1, 0, List.of()));
        assertThrows(ClientException.class, () -> new Measurement(0, 0, 0, 0, 0, 0, -1, List.of()));
        assertThrows(ClientException.class, () -> new ItemMeasurement("t", -1, 0, 0, 0));
        assertThrows(ClientException.class, () -> new ItemMeasurement("t", 0, 0, 0, -1));
        assertThrows(ClientException.class,
                () -> new GroupMeasurement(null, 0, 0, 0, 0, List.of()));

        Result empty = TokenAuditReconciler.reconcile(
                new Measurement(0, 0, 0, 0, 0, 0, 0, null));
        assertEquals(0, empty.messagesTokens());
        assertEquals(4, empty.items().size(), "没有工具时仍然只有 4 条消息行");
        assertEquals(0, empty.toolGroupingDrift());
    }

    @Test
    @DisplayName("工具名归一：空白归到 unknown_tool，超长截断到列宽 128")
    void toolNameNormalized() {
        String tooLong = "x".repeat(200);
        GroupMeasurement group = new GroupMeasurement(TokenAuditGroupKind.ORDINARY, 100, 0, 90, 2,
                List.of(new ItemMeasurement("  ", 40, 0, 30, 1),
                        new ItemMeasurement(tooLong, 60, 0, 60, 1)));

        Result result = TokenAuditReconciler.reconcile(
                new Measurement(0, 0, 0, 100, 0, 100, 0, List.of(group)));

        List<SessionTokenAuditItem> items = result.items().stream()
                .filter(row -> row.getLevel() == TokenAuditItemLevel.TOOL_ITEM)
                .toList();
        assertEquals(2, items.size());
        assertTrue(items.stream().anyMatch(row -> TokenAuditReconciler.UNKNOWN_TOOL_NAME
                .equals(row.getToolName())), "空白工具名必须归一到 unknown_tool");
        assertTrue(items.stream().allMatch(row ->
                        row.getToolName().length() <= TokenAuditReconciler.MAX_TOOL_NAME_LENGTH),
                "工具名必须截断到 128 字符（否则落库即超列宽）");
    }

    @Test
    @DisplayName("同名分组出现多次先合并再出值，不会产生两条同名分组行")
    void duplicateGroupsAreMerged() {
        Measurement duplicated = new Measurement(0, 0, 0, 200, 0, 200, 0, List.of(
                new GroupMeasurement(TokenAuditGroupKind.MCP, 120, 20, 100, 1, List.of()),
                new GroupMeasurement(TokenAuditGroupKind.MCP, 80, 10, 70, 2, List.of())));

        Result result = TokenAuditReconciler.reconcile(duplicated);

        List<SessionTokenAuditItem> groups = result.items().stream()
                .filter(row -> row.getLevel() == TokenAuditItemLevel.TOOL_GROUP)
                .toList();
        assertEquals(1, groups.size(), "同名分组必须合并成一行");
        assertEquals(200, groups.getFirst().resultTokens());
        assertEquals(3, groups.getFirst().getCallCount(), "条数按合并后的合计");
        assertEquals(200, toolRow(result).resultTokens());
    }

    private static Measurement measurementWithGroups() {
        return new Measurement(SYSTEM, USER, AI, TOOL_DOCUMENT, ARGUMENTS, LIVE_TOTAL, MAX_TOKENS,
                groups());
    }

    /** 带「工具定义」两项的测量值（框架 {@code e9c6ec6} 起可用）。 */
    private static Measurement measurementWithDefinitions() {
        return new Measurement(SYSTEM, USER, AI, TOOL_DOCUMENT, ARGUMENTS, LIVE_TOTAL, MAX_TOKENS,
                groups(), TOOL_DEFINITION, MCP_TOOL_DEFINITION);
    }

    private static List<GroupMeasurement> groups() {
        return List.of(
                new GroupMeasurement(TokenAuditGroupKind.MCP, MCP_TOKENS, 2100, MCP_TOKENS - 1700, 12,
                        List.of()),
                new GroupMeasurement(TokenAuditGroupKind.SKILL, SKILL_TOKENS, 800, SKILL_TOKENS - 1200,
                        3, List.of()),
                new GroupMeasurement(TokenAuditGroupKind.ORDINARY, ORDINARY_TOKENS, 3000,
                        ORDINARY_TOKENS - 560, 5, List.of(
                        new ItemMeasurement("search_web", SEARCH_WEB, 2100, 8700, 3),
                        new ItemMeasurement("read_file", READ_FILE, 900, 4600, 2))));
    }

    private static List<SessionTokenAuditItem> messageRows(Result result) {
        return result.items().stream()
                .filter(item -> item.getLevel() == TokenAuditItemLevel.MESSAGE)
                .toList();
    }

    private static SessionTokenAuditItem toolRow(Result result) {
        SessionTokenAuditItem row = messageRows(result).stream()
                .filter(item -> item.getCategory() == TokenAuditCategory.TOOL)
                .findFirst()
                .orElse(null);
        assertNotNull(row, "必须有 TOOL 消息行");
        return row;
    }
}
