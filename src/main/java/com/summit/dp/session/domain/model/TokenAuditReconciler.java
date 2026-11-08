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
 * <p><b>五条恒等式（本类强制保证，任何改动都必须让它们继续成立）</b>：</p>
 * <ol>
 *   <li>{@code messagesTokens = SYSTEM + USER + AI + TOOL}（四类求和在领域层算，不落库）</li>
 *   <li>{@code totalTokens = messagesTokens + requestOverheadTokens}，
 *       其中请求开销由 <b>减法</b>得出（{@code total - messages}），永不存在「不明差额」</li>
 *   <li>{@code TOOL = Σ(工具分组展示值)}，分组缺失时退化为框架工具视图的去重叠值</li>
 *   <li>{@code 普通工具分组 = Σ(各工具名展示值)}（子项优先，保证百分比之和恰为 100%）</li>
 *   <li>{@code requestOverheadTokens = toolDefinitionTokens + mcpToolDefinitionTokens
 *       + framingResidualTokens}（框架 e9c6ec6 起；后者的存在性由前两者是否已知决定）</li>
 * </ol>
 *
 * <p><b>框架口径已变（{@code d32ff83}）</b>：{@code ToolElement.totalTokens} / {@code ToolAuditDocument.toolTokens}
 * 现在是「结果消息 + 结果消息框架」，<b>不含工具调用参数</b>，参数仅作归因说明保留。
 * 因此 TOOL 视图直接取框架总量，<b>业务侧不得再做减法</b>；参数不参与任何求和，
 * 也不与总量做大小比较（两者已无包含关系）。</p>
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
     * @param totalTokens    框架原值（框架已去重叠，不含参数）
     * @param argumentTokens 工具调用参数 token（只读归因，与 totalTokens 无包含关系）
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
            // 新口径下 totalTokens（结果消息）与 argumentTokens（调用参数）是两个独立的量，
            // 不存在包含关系，因此**不做任何大小比较**：参数大于结果是完全正常的调用。
        }
    }

    /**
     * 一个工具分组（MCP / SKILL / ORDINARY）的原始测量值。
     *
     * @param groupKind      分组类型，不能为空
     * @param totalTokens    框架原值（框架已去重叠，不含参数）
     * @param argumentTokens 组内参数 token 合计（只读归因）
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
            // 与 ItemMeasurement 同理：新口径下总量与参数无包含关系，不做大小比较。
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
     * @param systemTokens            系统提示词 token
     * @param userTokens              用户消息 token
     * @param assistantTokens         AI 消息 token（含工具调用参数）
     * @param toolDocumentTokens      框架工具视图总量（框架已去重叠，不含参数）
     * @param argumentOverlapTokens   工具调用参数 token 合计（只读归因，不参与任何运算）
     * @param totalTokens             框架口径的模型输入总量；0 表示框架没给
     * @param maxTokens               审计当时的模型上下文上限；0 表示未知
     * @param groups                  工具分组测量值，可为空集合
     * @param toolDefinitionTokens    随请求下发的工具定义 token；<b>null 表示「框架未给出」</b>
     *                                （元素缺失、{@code NO_DATA} 或 {@code FAILED}），
     *                                <b>绝不允许用 0 顶替</b>
     * @param mcpToolDefinitionTokens 随请求下发的 MCP 工具定义 token；null 同义
     */
    public record Measurement(int systemTokens, int userTokens, int assistantTokens,
                              int toolDocumentTokens, int argumentOverlapTokens,
                              int totalTokens, int maxTokens, List<GroupMeasurement> groups,
                              Integer toolDefinitionTokens, Integer mcpToolDefinitionTokens,
                              Integer memoryTokens, Integer attachmentTokens) {

        public Measurement {
            requireNonNegative(systemTokens, "系统提示词 token");
            requireNonNegative(userTokens, "用户消息 token");
            requireNonNegative(assistantTokens, "AI 消息 token");
            requireNonNegative(toolDocumentTokens, "工具视图 token");
            requireNonNegative(argumentOverlapTokens, "工具参数 token");
            requireNonNegative(totalTokens, "模型输入总量");
            requireNonNegative(maxTokens, "上下文上限");
            // 新口径（框架 e9c6ec6）新增的两项「随请求下发的工具定义」：未知用 null 表达，
            // 已知时不得为负（负数只可能是框架测量异常或转换器写错，不该被静默画进构成图）。
            requireNonNegativeOrNull(toolDefinitionTokens, "工具定义 token");
            requireNonNegativeOrNull(mcpToolDefinitionTokens, "MCP 工具定义 token");
            // 归因明细（框架 e9c6ec6）：已知时同样不得为负。它们是 system / user 合计的
            // 明细拆分，绝不会被加进任何分类合计，因此这里只做合法性校验、不参与任何求和。
            requireNonNegativeOrNull(memoryTokens, "记忆正文 token");
            requireNonNegativeOrNull(attachmentTokens, "附件 token");
            // 参数与工具视图总量在新口径下是独立的两个量，不做大小比较。
            groups = groups == null ? List.of() : List.copyOf(groups);
        }

        /**
         * 兼容构造：不带「工具定义」两项时一律按<b>未知</b>（null）处理。
         *
         * @param systemTokens           系统提示词 token
         * @param userTokens             用户消息 token
         * @param assistantTokens        AI 消息 token
         * @param toolDocumentTokens     框架工具视图总量
         * @param argumentOverlapTokens  工具调用参数 token
         * @param totalTokens            模型输入总量
         * @param maxTokens              上下文上限
         * @param groups                 工具分组测量值
         */
        public Measurement(int systemTokens, int userTokens, int assistantTokens,
                           int toolDocumentTokens, int argumentOverlapTokens,
                           int totalTokens, int maxTokens, List<GroupMeasurement> groups) {
            this(systemTokens, userTokens, assistantTokens, toolDocumentTokens, argumentOverlapTokens,
                    totalTokens, maxTokens, groups, null, null, null, null);
        }

        /**
         * 兼容构造：不带「归因明细」两项（记忆 / 附件）时按未知（null）处理。
         *
         * @param systemTokens            系统提示词 token
         * @param userTokens              用户消息 token
         * @param assistantTokens         AI 消息 token
         * @param toolDocumentTokens      框架工具视图总量
         * @param argumentOverlapTokens   工具调用参数 token
         * @param totalTokens             模型输入总量
         * @param maxTokens               上下文上限
         * @param groups                  工具分组测量值
         * @param toolDefinitionTokens    工具定义 token
         * @param mcpToolDefinitionTokens MCP 工具定义 token
         */
        public Measurement(int systemTokens, int userTokens, int assistantTokens,
                           int toolDocumentTokens, int argumentOverlapTokens,
                           int totalTokens, int maxTokens, List<GroupMeasurement> groups,
                           Integer toolDefinitionTokens, Integer mcpToolDefinitionTokens) {
            this(systemTokens, userTokens, assistantTokens, toolDocumentTokens, argumentOverlapTokens,
                    totalTokens, maxTokens, groups, toolDefinitionTokens, mcpToolDefinitionTokens,
                    null, null);
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
     * @param toolGroupingDrift     诊断值：框架工具视图展示值 − 各分组展示值之和
     *                              （常态为负：每个分组独立测量各带一个 primer，
     *                              量级 3 × (分组数 − 1)；不为 0 也不影响其余恒等式）
     * @param toolDefinitionTokens    随请求下发的工具定义 token；null = 未知（框架未给出）
     * @param mcpToolDefinitionTokens 随请求下发的 MCP 工具定义 token；null = 未知
     * @param framingResidualTokens   请求框架残差，由恒等式 B 的减法派生，<b>不落库</b>；
     *                                两项工具定义任一未知时为 null（未知就整体未知，
     *                                拿部分已知去凑一个「残差」只会骗人）
     * @param memoryTokens            记忆正文 token（{@code OtherTokens.memoryTokens}）；null = 未知
     * @param attachmentTokens        用户附件 token（{@code OtherTokens.attachmentTokens}）；null = 未知
     * @param items                 明细行（4 条消息行 + 0~3 条分组行 + N 条工具名行）
     */
    public record Result(int totalTokens, int maxTokens, int messagesTokens, int requestOverheadTokens,
                         int overlapTokens, int toolGroupingDrift, Integer toolDefinitionTokens,
                         Integer mcpToolDefinitionTokens, Integer framingResidualTokens,
                         Integer memoryTokens, Integer attachmentTokens,
                         List<SessionTokenAuditItem> items) {

        public Result {
            requireNonNegativeOrNull(toolDefinitionTokens, "工具定义 token");
            requireNonNegativeOrNull(mcpToolDefinitionTokens, "MCP 工具定义 token");
            // 归因明细：只校验合法性。二者已分别包含在 systemTokens / userTokens 里，
            // 绝不参与 messagesTokens、requestOverheadTokens、totalTokens 的任何求和。
            requireNonNegativeOrNull(memoryTokens, "记忆正文 token");
            requireNonNegativeOrNull(attachmentTokens, "附件 token");
            items = items == null ? List.of() : List.copyOf(items);
        }

        /**
         * 兼容构造：不带「工具定义」三项时一律按未知（null）处理。
         *
         * <p>保留它是因为「没有工具定义审计」本身是合法状态（老框架、审计失败），
         * 此时恒等式 B 不参与校验，其余三条恒等式照常成立。</p>
         *
         * @param totalTokens           总量
         * @param maxTokens             上下文上限
         * @param messagesTokens        四类分项之和
         * @param requestOverheadTokens 请求开销
         * @param overlapTokens         参数 token
         * @param toolGroupingDrift     归因漂移
         * @param items                 明细行
         */
        public Result(int totalTokens, int maxTokens, int messagesTokens, int requestOverheadTokens,
                      int overlapTokens, int toolGroupingDrift, List<SessionTokenAuditItem> items) {
            this(totalTokens, maxTokens, messagesTokens, requestOverheadTokens, overlapTokens,
                    toolGroupingDrift, null, null, null, null, null, items);
        }

        /**
         * 兼容构造：不带「归因明细」两项（记忆 / 附件）时按未知（null）处理。
         *
         * @param totalTokens            总量
         * @param maxTokens              上下文上限
         * @param messagesTokens         四类分项之和
         * @param requestOverheadTokens  请求开销
         * @param overlapTokens          参数 token
         * @param toolGroupingDrift      归因漂移
         * @param toolDefinitionTokens   工具定义 token
         * @param mcpToolDefinitionTokens MCP 工具定义 token
         * @param framingResidualTokens  请求框架残差
         * @param items                  明细行
         */
        public Result(int totalTokens, int maxTokens, int messagesTokens, int requestOverheadTokens,
                      int overlapTokens, int toolGroupingDrift, Integer toolDefinitionTokens,
                      Integer mcpToolDefinitionTokens, Integer framingResidualTokens,
                      List<SessionTokenAuditItem> items) {
            this(totalTokens, maxTokens, messagesTokens, requestOverheadTokens, overlapTokens,
                    toolGroupingDrift, toolDefinitionTokens, mcpToolDefinitionTokens,
                    framingResidualTokens, null, null, items);
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
        // 框架已去重叠（d32ff83），业务侧不再做减法，直接取框架总量。
        int frameworkToolDisplay = measurement.toolDocumentTokens();
        int toolDisplayTokens = hasGroups ? toolGroupTokens : frameworkToolDisplay;
        int toolGroupingDrift = frameworkToolDisplay - toolDisplayTokens;

        int messagesTokens = measurement.systemTokens() + measurement.userTokens()
                + measurement.assistantTokens() + toolDisplayTokens;

        // 恒等式 2：请求开销只由减法得出。框架没给总量（0）时退化为 0，
        // 否则会算出「减去全部消息」的巨大负残差，那是把「缺失」伪装成「开销」。
        int totalTokens = measurement.totalTokens() > 0 ? measurement.totalTokens() : messagesTokens;
        int requestOverheadTokens = totalTokens - messagesTokens;

        // 恒等式 5（框架 e9c6ec6）：请求开销 = 工具定义 + MCP 工具定义 + 请求框架残差。
        // 残差由减法派生、不落库；两项工具定义任一未知时整体为未知（null），
        // 拿「部分已知」去凑一个残差只会把未知伪装成已知。
        Integer toolDefinitionTokens = measurement.toolDefinitionTokens();
        Integer mcpToolDefinitionTokens = measurement.mcpToolDefinitionTokens();
        Integer framingResidualTokens =
                framingResidual(requestOverheadTokens, toolDefinitionTokens, mcpToolDefinitionTokens);
        verifyDecomposition(requestOverheadTokens, toolDefinitionTokens, mcpToolDefinitionTokens,
                framingResidualTokens);

        // TOOL 消息行存 toolDisplayTokens：有分组时即 Σ分组展示值，保证前端「子项求和 == 父项」；
        // 与框架总量的差额（toolGroupingDrift）单独落库，不在这里掰平。
        // 框架已去重叠（d32ff83），resultTokens() 不再做减法。
        // 参数只挂在 AI 行作归因说明（参数本来就算进 assistantTokens），不参与任何求和。
        List<SessionTokenAuditItem> messageRows = new ArrayList<>(4);
        messageRows.add(SessionTokenAuditItem.message(TokenAuditCategory.SYSTEM,
                measurement.systemTokens(), 0, SYSTEM_ORDER));
        messageRows.add(SessionTokenAuditItem.message(TokenAuditCategory.USER,
                measurement.userTokens(), 0, USER_ORDER));
        messageRows.add(SessionTokenAuditItem.message(TokenAuditCategory.AI,
                measurement.assistantTokens(), measurement.argumentOverlapTokens(), AI_ORDER));
        messageRows.add(SessionTokenAuditItem.message(TokenAuditCategory.TOOL,
                toolDisplayTokens, 0, TOOL_ORDER));
        messageRows.addAll(items);

        return new Result(totalTokens, measurement.maxTokens(), messagesTokens, requestOverheadTokens,
                measurement.argumentOverlapTokens(), toolGroupingDrift,
                toolDefinitionTokens, mcpToolDefinitionTokens, framingResidualTokens,
                measurement.memoryTokens(), measurement.attachmentTokens(), messageRows);
    }

    /**
     * 恒等式 5 的派生：请求框架残差 = 请求开销 − 工具定义 − MCP 工具定义。
     *
     * <p><b>为什么由减法派生而不落库</b>：它是「扣掉两项已知开销后剩下的部分」，
     * 存下来只会多一份可能与另外两列对不上的事实。查询期用同样的减法现算即可。</p>
     *
     * <p><b>为什么可能是负数</b>：与 {@code requestOverheadTokens} 同源 —— 当请求开销本身很小，
     * 或框架把某段 primer 在两个元素里各算了一次时，残差会转负。这与「未知」是两回事，
     * 因此不套用「非负校验」，只要求三项之和能回到请求开销（见 {@link #verifyDecomposition}）。</p>
     *
     * @param requestOverhead        请求开销，可为 null
     * @param toolDefinitionTokens   工具定义 token，可为 null（未知）
     * @param mcpToolDefinitionTokens MCP 工具定义 token，可为 null（未知）
     * @return 残差；任一入参为 null 时返回 null
     */
    public static Integer framingResidual(Integer requestOverhead, Integer toolDefinitionTokens,
                                          Integer mcpToolDefinitionTokens) {
        if (requestOverhead == null || toolDefinitionTokens == null || mcpToolDefinitionTokens == null) {
            return null;
        }
        return requestOverhead - toolDefinitionTokens - mcpToolDefinitionTokens;
    }

    /**
     * 校验恒等式 5：三项之和必须精确回到请求开销。
     *
     * <p><b>这不是死代码</b>：残差是派生的，因此该断言恒成立 —— 除非派生被改坏（符号写反、
     * 少减一项）或整数溢出。成功路径的用例把它钉住，任何破坏「请求开销可被精确拆成三项」的改动
     * 都会在这里立刻变红，而不是等到前端把构成图画歪才被发现。差额会写进异常文案，便于定位。</p>
     *
     * @param requestOverhead        请求开销
     * @param toolDefinitionTokens   工具定义 token，可为 null
     * @param mcpToolDefinitionTokens MCP 工具定义 token，可为 null
     * @param framingResidualTokens  派生残差，可为 null
     * @throws ClientException 三项之和不等于请求开销
     */
    public static void verifyDecomposition(int requestOverhead, Integer toolDefinitionTokens,
                                           Integer mcpToolDefinitionTokens,
                                           Integer framingResidualTokens) {
        if (toolDefinitionTokens == null || mcpToolDefinitionTokens == null
                || framingResidualTokens == null) {
            return;
        }
        int decomposed = toolDefinitionTokens + mcpToolDefinitionTokens + framingResidualTokens;
        if (decomposed != requestOverhead) {
            throw new ClientException("token 审计恒等式不成立：非消息请求开销 " + requestOverhead
                    + " ≠ 工具定义 " + toolDefinitionTokens + " + MCP 工具定义 "
                    + mcpToolDefinitionTokens + " + 请求框架残差 " + framingResidualTokens
                    + "（差额 " + (requestOverhead - decomposed) + "）");
        }
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
     * 可空值的非负校验：null 表示「未知」，是合法状态；一旦有值就不许为负。
     *
     * @param value 待校验值，可为 null
     * @param label 出错时的字段说明
     * @throws ClientException 值存在且为负数
     */
    private static void requireNonNegativeOrNull(Integer value, String label) {
        if (value != null && value < 0) {
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

        /** 展示值：框架已去重叠，{@code totalTokens} 即展示值，不做减法。 */
        private int displayTokens() {
            return totalTokens;
        }
    }
}
