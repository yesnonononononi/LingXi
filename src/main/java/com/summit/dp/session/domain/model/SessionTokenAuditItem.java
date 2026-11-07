package com.summit.dp.session.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.Getter;

/**
 * 审计快照的一条明细行。
 *
 * <p><b>数值契约（本次最容易被改坏的地方）</b>：{@link #totalTokens} 永远是框架原值（含工具调用参数），
 * 展示用的去重叠值只由 {@link #resultTokens()} 现算。任何时候都不许把去重叠值写回
 * {@code total_tokens} 列 —— 那会让 AI 项没扣、TOOL 项扣两次，总数越用越少，
 * 且历史快照再也解释不清。</p>
 *
 * <p>为什么参数不参与任何求和：框架的 {@code assistantTokens} 已经把工具调用参数算进去了，
 * TOOL 视图再算一遍就是重复。参数只作只读说明字段（{@link #argumentTokens}）下发。</p>
 */
@Getter
public final class SessionTokenAuditItem {

    /** 明细行标识；新建（未落库）时为 null，仓储读回后才有值。 */
    private final Long id;
    private final TokenAuditItemLevel level;
    private final TokenAuditCategory category;
    /** 消息类行为 null。 */
    private final TokenAuditGroupKind groupKind;
    /** 只有普通工具明细行才有值。 */
    private final String toolName;
    /** 该聚合项覆盖的调用条数（前端「N 项」徽标）。 */
    private final int callCount;
    /** 框架原值，含 {@link #argumentTokens}。 */
    private final int totalTokens;
    /** 工具调用参数 token：已计入 AI 项，仅作说明。 */
    private final int argumentTokens;
    private final int outputTokens;
    private final int sortOrder;

    private SessionTokenAuditItem(Long id, TokenAuditItemLevel level, TokenAuditCategory category,
                                 TokenAuditGroupKind groupKind, String toolName, int callCount,
                                 int totalTokens, int argumentTokens, int outputTokens, int sortOrder) {
        this.level = requireLevel(level);
        this.category = requireCategory(category);
        this.groupKind = groupKind;
        this.toolName = toolName;
        this.callCount = requireNonNegative(callCount, "调用条数");
        this.totalTokens = requireNonNegative(totalTokens, "token 总量");
        this.argumentTokens = requireNonNegative(argumentTokens, "参数 token");
        this.outputTokens = requireNonNegative(outputTokens, "输出 token");
        this.sortOrder = requireNonNegative(sortOrder, "排序序号");
        requireArgumentWithinTotal(this.category, this.totalTokens, this.argumentTokens);
        requireShape(this.level, this.category, this.groupKind, this.toolName);
        this.id = id;
    }

    /**
     * 消息构成行（SYSTEM / USER / AI / TOOL）。
     *
     * @param category       分类，不能为空
     * @param totalTokens    框架原值（TOOL 行也含参数）
     * @param argumentTokens 仅 TOOL 行可能非 0
     * @param sortOrder      固定展示顺序，从 1 开始
     */
    public static SessionTokenAuditItem message(TokenAuditCategory category, int totalTokens,
                                                int argumentTokens, int sortOrder) {
        return new SessionTokenAuditItem(null, TokenAuditItemLevel.MESSAGE, category, null, null,
                0, totalTokens, argumentTokens, 0, sortOrder);
    }

    /**
     * 工具分组行（MCP / SKILL / ORDINARY）。
     *
     * @param groupKind      分组，不能为空
     * @param callCount      组内调用条数
     * @param totalTokens    框架原值（含参数）
     * @param argumentTokens 组内参数 token 合计
     * @param outputTokens   组内工具输出 token 合计
     * @param sortOrder      组内展示顺序，从 1 开始
     */
    public static SessionTokenAuditItem toolGroup(TokenAuditGroupKind groupKind, int callCount,
                                                  int totalTokens, int argumentTokens,
                                                  int outputTokens, int sortOrder) {
        return new SessionTokenAuditItem(null, TokenAuditItemLevel.TOOL_GROUP, TokenAuditCategory.TOOL,
                requireGroupKind(groupKind), null, callCount, totalTokens, argumentTokens, outputTokens,
                sortOrder);
    }

    /**
     * 普通工具明细行（按工具名聚合）。
     *
     * @param toolName       工具名；空值按框架兜底名 {@code unknown_tool} 处理
     * @param callCount      该工具调用条数
     * @param totalTokens    框架原值（含参数）
     * @param argumentTokens 该工具参数 token 合计
     * @param outputTokens   该工具输出 token 合计
     * @param sortOrder      组内展示顺序，从 1 开始
     */
    public static SessionTokenAuditItem toolItem(String toolName, int callCount, int totalTokens,
                                                 int argumentTokens, int outputTokens, int sortOrder) {
        return new SessionTokenAuditItem(null, TokenAuditItemLevel.TOOL_ITEM, TokenAuditCategory.TOOL,
                TokenAuditGroupKind.ORDINARY, normalizeToolName(toolName), callCount, totalTokens,
                argumentTokens, outputTokens, sortOrder);
    }

    /**
     * 仓储重建：完全按库里的值还原，不做任何重算与改写。
     *
     * <p>仍然走同一套不变量校验：库里的行如果违反口径（例如负数 token、层级与字段不匹配），
     * 读出来就该失败而不是把脏数据当成事实展示给用户。</p>
     */
    public static SessionTokenAuditItem restore(Long id, TokenAuditItemLevel level, TokenAuditCategory category,
                                                TokenAuditGroupKind groupKind, String toolName, int callCount,
                                                int totalTokens, int argumentTokens, int outputTokens,
                                                int sortOrder) {
        return new SessionTokenAuditItem(id, level, category, groupKind, toolName, callCount, totalTokens,
                argumentTokens, outputTokens, sortOrder);
    }

    /**
     * 展示用的去重叠值：TOOL 类减去已计入 AI 项的工具调用参数，其余分类原值。
     *
     * <p>这是「参数不重复计入」的唯一实现点，绝不允许在别处再扣一次。</p>
     */
    public int resultTokens() {
        return category == TokenAuditCategory.TOOL ? totalTokens - argumentTokens : totalTokens;
    }

    /**
     * 占父级 token 的比例。
     *
     * @param parentTokens 父级 token；为 {@code null} 或 {@code <= 0} 时返回 {@code null}
     *                     （父级为 0 时任何比例都无意义，返回 0 或 NaN 都会让前端画出误导性条形）
     * @return 0~1 的比例，可能大于 1（超限）
     */
    public Double ratioOf(Integer parentTokens) {
        if (parentTokens == null || parentTokens <= 0) {
            return null;
        }
        return (double) resultTokens() / parentTokens;
    }

    private static TokenAuditItemLevel requireLevel(TokenAuditItemLevel level) {
        if (level == null) {
            throw new ClientException("token 审计明细层级不能为空");
        }
        return level;
    }

    private static TokenAuditCategory requireCategory(TokenAuditCategory category) {
        if (category == null) {
            throw new ClientException("token 审计明细分类不能为空");
        }
        return category;
    }

    private static TokenAuditGroupKind requireGroupKind(TokenAuditGroupKind groupKind) {
        if (groupKind == null) {
            throw new ClientException("工具分组行必须指明分组类型");
        }
        return groupKind;
    }

    private static int requireNonNegative(int value, String label) {
        if (value < 0) {
            throw new ClientException("token 审计明细的" + label + "不能为负数: " + value);
        }
        return value;
    }

    /** 参数已经计入 AI 项，这里只允许它不超过原值：否则去重叠后会得到负数 token 行。 */
    private static void requireArgumentWithinTotal(TokenAuditCategory category, int totalTokens,
                                                   int argumentTokens) {
        if (category == TokenAuditCategory.TOOL && argumentTokens > totalTokens) {
            throw new ClientException("工具调用参数 token 超出工具视图总量: 参数=" + argumentTokens
                    + "，总量=" + totalTokens);
        }
    }

    /** 层级决定哪些字段必须有值：三者错配就是 DDL 与领域模型不同步。 */
    private static void requireShape(TokenAuditItemLevel level, TokenAuditCategory category,
                                     TokenAuditGroupKind groupKind, String toolName) {
        switch (level) {
            case MESSAGE -> {
                if (groupKind != null || toolName != null) {
                    throw new ClientException("消息类明细行不能带工具分组或工具名");
                }
            }
            case TOOL_GROUP -> {
                if (category != TokenAuditCategory.TOOL || groupKind == null) {
                    throw new ClientException("工具分组明细行必须是 TOOL 分类且带分组类型");
                }
                if (toolName != null) {
                    throw new ClientException("工具分组明细行不能带工具名");
                }
            }
            case TOOL_ITEM -> {
                if (category != TokenAuditCategory.TOOL || groupKind != TokenAuditGroupKind.ORDINARY) {
                    throw new ClientException("工具明细行必须是 TOOL 分类且属于普通工具分组");
                }
                if (toolName == null || toolName.isBlank()) {
                    throw new ClientException("工具明细行必须有工具名");
                }
            }
            default -> throw new ClientException("无法处理的 token 审计明细层级: " + level);
        }
    }

    /** 框架对无法归名的工具用 {@code unknown_tool} 兜底；照实展示，不要丢掉该分组。 */
    private static String normalizeToolName(String toolName) {
        if (toolName == null || toolName.isBlank()) {
            return TokenAuditReconciler.UNKNOWN_TOOL_NAME;
        }
        String stripped = toolName.strip();
        return stripped.length() <= TokenAuditReconciler.MAX_TOOL_NAME_LENGTH
                ? stripped : stripped.substring(0, TokenAuditReconciler.MAX_TOOL_NAME_LENGTH);
    }
}
