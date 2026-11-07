package com.summit.dp.session.domain.model;

import com.summit.dp.shared.exception.ClientException;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 口径唯一真源：把框架测出来的扁平 token 数换算成「四类分项 + 工具下钻 + 请求开销」。
 *
 * <p><b>为什么要一个专门的领域服务</b>：本功能的全部风险都在算术口径上（去重叠、四类求和、
 * 请求开销的减法、分组与工具名的父子一致）。把这几步集中在纯静态方法里，
 * 才可能被 Pitest 的默认扫描包覆盖，也才可能在框架口径变化时一处修完全局生效。</p>
 *
 * <p><b>四条恒等式（本类强制保证，任何改动都必须让它们继续成立）</b>：</p>
 * <ol>
 *   <li>{@code messagesTokens = SYSTEM + USER + AI + TOOL}（四类求和在领域层算，不落库）</li>
 *   <li>{@code totalTokens = messagesTokens + requestOverheadTokens}，
 *       其中请求开销由 <b>减法</b>得出（{@code total - messages}），永不存在「不明差额」</li>
 *   <li>{@code TOOL = Σ(工具分组展示值)}，分组缺失时退化为框架工具视图的去重叠值</li>
 *   <li>{@code 普通工具分组 = Σ(各工具名展示值)}（子项优先，保证百分比之和恰为 100%）</li>
 * </ol>
 *
 * <p>框架的 {@code ToolElement.totalTokens} 含工具调用参数，而参数已计入 {@code assistantTokens}；
 * 因此 TOOL 视图一律按「结果消息 + 结果消息框架」展示（{@link SessionTokenAuditItem#resultTokens()}），
 * 参数只作为 {@link Result#overlapTokens()} 说明字段下发，不参与任何求和。</p>
 */
public final class TokenAuditReconciler {

    /** 框架对无法归名的工具的兜底名，照实展示（丢了它会让普通工具求和与 TOOL 对不上）。 */
    public static final String UNKNOWN_TOOL_NAME = "unknown_tool";

    /** 工具名长度上限，与 {@code session_token_audit_item.tool_name VARCHAR(128)} 一致。 */
    public static final int MAX_TOOL_NAME_LENGTH = 128;

    /** 四类消息分项的固定展示顺序。 */
    private static final int SYSTEM_ORDER = 1;
    private static final int USER_ORDER = 2;
    private static final int AI_ORDER = 3;
    private static final int TOOL_ORDER = 4;

    private TokenAuditReconciler() {
        // 纯静态领域服务，不允许实例化
    }

    /**
     * 单个工具名（普通工具明细）的原始测量值。
     *
     * @param toolName       工具名；空值按 {@link #UNKNOWN_TOOL_NAME} 处理
     * @param totalTokens    框架原值（含参数）
     * @param argumentTokens 工具调用参数 token
     * @param outputTokens   工具输出文本 token
     * @param callCount      调用条数
     */
    public record ItemMeasurement(String toolName, int totalTokens, int argumentTokens,
                                  int outputTokens, int callCount) {

        public ItemMeasurement {
            requireNonNegative(totalTokens, "工具 token 总量");
            requireNonNegative(argumentTokens, "工具参数 token");
            requireNonNegative(outputTokens, "工具输出 token");
            requireNonNegative(callCount, "工具调用条数");
            if (argumentTokens > totalTokens) {
                throw new ClientException("工具参数 token 超出该工具 token 总量: tool="
                        + toolName + "，参数=" + argumentTokens + "，总量=" + totalTokens);
            }
        }
    }

    /**
     * 一个工具分组（MCP / SKILL / ORDINARY）的原始测量值。
     *
     * @param groupKind      分组类型，不能为空
     * @param totalTokens    框架原值（含参数）
     * @param argumentTokens 组内参数 token 合计
     * @param outputTokens   组内工具输出 token 合计
     * @param callCount      组内调用条数（框架参数是分组级聚合，不能从 token 反推）
     * @param items          仅 ORDINARY 分组可能有工具名明细；其余分组传空集合
     */
    public record GroupMeasurement(TokenAuditGroupKind groupKind, int totalTokens, int argumentTokens,
                                   int outputTokens, int callCount, List<ItemMeasurement> items) {

        public GroupMeasurement {
            if (groupKind == null) {
                throw new ClientException("工具分组测量值必须指明分组类型");
            }
            requireNonNegative(totalTokens, "工具分组 token 总量");
            requireNonNegative(argumentTokens, "工具分组参数 token");
            requireNonNegative(outputTokens, "工具分组输出 token");
            requireNonNegative(callCount, "工具分组调用条数");
            if (argumentTokens > totalTokens) {
                throw new ClientException("工具分组参数 token 超出分组 token 总量: 分组=" + groupKind
                        + "，参数=" + argumentTokens + "，总量=" + totalTokens);
            }
            items = items == null ? List.of() : List.copyOf(items);
        }
    }

    /**
     * 转换器产出的扁平测量值（框架类型只在转换器里出现，领域只认这些数）。
     *
     * <p><b>为什么必须带 {@link #totalTokens}</b>：请求开销只允许由减法得出
     * （{@code total - messages}）。设计类图里没有这个字段，但没有它就只能靠「工具定义开销 − 9」
     * 去独立估算，那等于把框架实现细节抄进业务仓，一旦框架改动就会静默错位。
     * 该值是框架口径的「模型输入总量」（消息 + 工具定义 + 请求框架），由转换器负责取值，
     * 取不到时传 0，本类会退化成「请求开销 = 0」而不是造出一个巨大的负残差。</p>
     *
     * @param systemTokens           系统提示词 token
     * @param userTokens             用户消息 token
     * @param assistantTokens        AI 消息 token（含工具调用参数）
     * @param toolDocumentTokens     框架工具视图总量（含参数）
     * @param argumentOverlapTokens  工具调用参数 token 合计
     * @param totalTokens            框架口径的模型输入总量；0 表示框架没给
     * @param maxTokens              审计当时的模型上下文上限；0 表示未知
     * @param groups                 工具分组测量值，可为空集合
     */
    public record Measurement(int systemTokens, int userTokens, int assistantTokens,
                              int toolDocumentTokens, int argumentOverlapTokens,
                              int totalTokens, int maxTokens, List<GroupMeasurement> groups) {

        public Measurement {
            requireNonNegative(systemTokens, "系统提示词 token");
            requireNonNegative(userTokens, "用户消息 token");
            requireNonNegative(assistantTokens, "AI 消息 token");
            requireNonNegative(toolDocumentTokens, "工具视图 token");
            requireNonNegative(argumentOverlapTokens, "工具参数 token");
            requireNonNegative(totalTokens, "模型输入总量");
            requireNonNegative(maxTokens, "上下文上限");
            if (argumentOverlapTokens > toolDocumentTokens) {
                throw new ClientException("工具调用参数 token 超出工具视图总量: 参数="
                        + argumentOverlapTokens + "，总量=" + toolDocumentTokens);
            }
            groups = groups == null ? List.of() : List.copyOf(groups);
        }
    }

    /**
     * 换算结果：落到头表的标量 + 落到明细表的行。
     *
     * @param totalTokens           框架口径总量（{@code messagesTokens + requestOverheadTokens}）
     * @param maxTokens             审计当时的上下文上限（0 表示未知）
     * @param messagesTokens        四类分项之和（已去重叠）
     * @param requestOverheadTokens 非消息请求开销，由减法得出，可能为负（无工具时为 -9 量级）
     * @param overlapTokens         工具调用参数 token，仅说明，不参与求和
     * @param toolGroupingDrift     诊断值：框架工具视图去重叠值 − 各分组展示值之和
     *                              （常态为负：每个分组独立测量各带一个 primer，
     *                              量级 3 × (分组数 − 1)；不为 0 也不影响其余恒等式）
     * @param items                 明细行（4 条消息行 + 0~3 条分组行 + N 条工具名行）
     */
    public record Result(int totalTokens, int maxTokens, int messagesTokens, int requestOverheadTokens,
                         int overlapTokens, int toolGroupingDrift, List<SessionTokenAuditItem> items) {

        public Result {
            items = items == null ? List.of() : List.copyOf(items);
        }
    }

    /**
     * 按口径把测量值换算成快照数值与明细行。
     *
     * @param measurement 转换器产出的扁平测量值
     * @return 头表标量 + 明细行
     * @throws ClientException 入参为 null 或数值口径不自洽
     */
    public static Result reconcile(Measurement measurement) {
        if (measurement == null) {
            throw new ClientException("token 审计测量值不能为空");
        }
        List<SessionTokenAuditItem> items = new ArrayList<>();
        int toolGroupTokens = reconcileToolGroups(measurement, items);
        boolean hasGroups = !items.isEmpty();

        // 恒等式 3：有分组时 TOOL = Σ分组展示值（子项优先）；无分组时退回框架工具视图。
        int frameworkToolDisplay = measurement.toolDocumentTokens() - measurement.argumentOverlapTokens();
        int toolDisplayTokens = hasGroups ? toolGroupTokens : frameworkToolDisplay;
        int toolGroupingDrift = frameworkToolDisplay - toolDisplayTokens;

        int messagesTokens = measurement.systemTokens() + measurement.userTokens()
                + measurement.assistantTokens() + toolDisplayTokens;

        // 恒等式 2：请求开销只由减法得出。框架没给总量（0）时退化为 0，
        // 否则会算出「减去全部消息」的巨大负残差，那是把「缺失」伪装成「开销」。
        int totalTokens = measurement.totalTokens() > 0 ? measurement.totalTokens() : messagesTokens;
        int requestOverheadTokens = totalTokens - messagesTokens;

        // TOOL 消息行存框架原值：展示值 + 参数，保证 resultTokens() 恰好还原展示值。
        int toolArgument = Math.min(measurement.argumentOverlapTokens(), toolDisplayTokens);
        List<SessionTokenAuditItem> messageRows = new ArrayList<>(4);
        messageRows.add(SessionTokenAuditItem.message(TokenAuditCategory.SYSTEM,
                measurement.systemTokens(), 0, SYSTEM_ORDER));
        messageRows.add(SessionTokenAuditItem.message(TokenAuditCategory.USER,
                measurement.userTokens(), 0, USER_ORDER));
        messageRows.add(SessionTokenAuditItem.message(TokenAuditCategory.AI,
                measurement.assistantTokens(), 0, AI_ORDER));
        messageRows.add(SessionTokenAuditItem.message(TokenAuditCategory.TOOL,
                toolDisplayTokens + toolArgument, toolArgument, TOOL_ORDER));
        messageRows.addAll(items);

        return new Result(totalTokens, measurement.maxTokens(), messagesTokens, requestOverheadTokens,
                measurement.argumentOverlapTokens(), toolGroupingDrift, messageRows);
    }

    /**
     * 生成工具分组行与工具名明细行，返回「各分组展示值之和」。
     *
     * <p>同名分组若出现多次先合并再出值：框架未来若按 server 拆分会话内可能出现多条 MCP 记录，
     * 合并比取第一条更接近事实，也不会让明细行数变成未定义。</p>
     */
    private static int reconcileToolGroups(Measurement measurement, List<SessionTokenAuditItem> items) {
        Map<TokenAuditGroupKind, GroupAccumulator> accumulators =
                new EnumMap<>(TokenAuditGroupKind.class);
        for (GroupMeasurement group : measurement.groups()) {
            if (group == null) {
                continue;
            }
            accumulators.computeIfAbsent(group.groupKind(), kind -> new GroupAccumulator())
                    .add(group);
        }
        int sum = 0;
        int sortOrder = 1;
        for (TokenAuditGroupKind kind : TokenAuditGroupKind.values()) {
            GroupAccumulator accumulator = accumulators.get(kind);
            if (accumulator == null) {
                continue;
            }
            SessionTokenAuditItem groupRow = accumulator.toGroupRow(kind, sortOrder);
            sum += groupRow.resultTokens();
            items.add(groupRow);
            sortOrder++;
            if (kind == TokenAuditGroupKind.ORDINARY) {
                items.addAll(accumulator.toItemRows());
            }
        }
        return sum;
    }

    private static void requireNonNegative(int value, String label) {
        if (value < 0) {
            throw new ClientException("token 审计测量值的" + label + "不能为负数: " + value);
        }
    }

    /**
     * 同名分组的累加器。
     *
     * <p>普通工具分组的值由工具名明细求和得出（恒等式 4），因此这里同时保留分组原值与工具名明细，
     * 出值时才决定用哪一个 —— 保证「分组 = Σ工具名」永不漂移。</p>
     */
    private static final class GroupAccumulator {

        private int totalTokens = 0;
        private int argumentTokens = 0;
        private int outputTokens = 0;
        private int callCount = 0;
        private final Map<String, ItemAccumulator> items = new LinkedHashMap<>();

        private void add(GroupMeasurement group) {
            totalTokens += group.totalTokens();
            argumentTokens += group.argumentTokens();
            outputTokens += group.outputTokens();
            callCount += group.callCount();
            for (ItemMeasurement item : group.items()) {
                items.computeIfAbsent(normalizeName(item.toolName()),
                        name -> new ItemAccumulator()).add(item);
            }
        }

        private SessionTokenAuditItem toGroupRow(TokenAuditGroupKind kind, int sortOrder) {
            if (items.isEmpty()) {
                return SessionTokenAuditItem.toolGroup(kind, callCount, totalTokens, argumentTokens,
                        outputTokens, sortOrder);
            }
            int itemRaw = 0;
            int itemArgument = 0;
            int itemOutput = 0;
            int itemCalls = 0;
            for (ItemAccumulator item : items.values()) {
                itemRaw += item.totalTokens;
                itemArgument += item.argumentTokens;
                itemOutput += item.outputTokens;
                itemCalls += item.callCount;
            }
            // 恒等式 4：普通工具分组取「Σ工具名」，框架给的组级聚合值不参与展示，
            // 否则组内百分比之和不会是 100%。调用条数同理以明细为准。
            return SessionTokenAuditItem.toolGroup(kind, itemCalls, itemRaw, itemArgument, itemOutput,
                    sortOrder);
        }

        /** 工具名明细按展示值降序，同值按名字升序：顺序必须稳定，否则每次采集行序都在变。 */
        private List<SessionTokenAuditItem> toItemRows() {
            List<Map.Entry<String, ItemAccumulator>> ordered = new ArrayList<>(items.entrySet());
            ordered.sort(Comparator
                    .comparingInt((Map.Entry<String, ItemAccumulator> entry) -> entry.getValue().displayTokens())
                    .reversed()
                    .thenComparing(Map.Entry::getKey));
            List<SessionTokenAuditItem> rows = new ArrayList<>(ordered.size());
            int sortOrder = 1;
            for (Map.Entry<String, ItemAccumulator> entry : ordered) {
                ItemAccumulator item = entry.getValue();
                rows.add(SessionTokenAuditItem.toolItem(entry.getKey(), item.callCount, item.totalTokens,
                        item.argumentTokens, item.outputTokens, sortOrder));
                sortOrder++;
            }
            return rows;
        }

        private static String normalizeName(String toolName) {
            if (toolName == null || toolName.isBlank()) {
                return UNKNOWN_TOOL_NAME;
            }
            String stripped = toolName.strip();
            return stripped.length() <= MAX_TOOL_NAME_LENGTH
                    ? stripped : stripped.substring(0, MAX_TOOL_NAME_LENGTH);
        }
    }

    /** 单个工具名的累加器（同名工具可能出现多次）。 */
    private static final class ItemAccumulator {

        private int totalTokens = 0;
        private int argumentTokens = 0;
        private int outputTokens = 0;
        private int callCount = 0;

        private void add(ItemMeasurement item) {
            totalTokens += item.totalTokens();
            argumentTokens += item.argumentTokens();
            outputTokens += item.outputTokens();
            callCount += item.callCount();
        }

        private int displayTokens() {
            return totalTokens - argumentTokens;
        }
    }
}
