package com.summit.dp.session.application.convert;

import com.summit.core.audit.AuditStatus;
import com.summit.core.audit.DocumentElement;
import com.summit.core.audit.token.OtherTokens;
import com.summit.core.audit.token.TokenAuditDocument;
import com.summit.core.audit.token.tool.ToolAuditDocument;
import com.summit.core.audit.token.tool.ToolElement;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.TokenAuditGroupKind;
import com.summit.dp.session.domain.model.TokenAuditReconciler.GroupMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.ItemMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Measurement;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 框架审计文档 → 领域扁平测量值（{@link Measurement}）。
 *
 * <p><b>框架类型只允许出现在这一层</b>：{@code TokenAuditDocument} / {@code ToolAuditDocument} /
 * {@code ToolElement} 全部在此收口，领域模型只认 {@code int} 与 {@link GroupMeasurement}，
 * 这样框架口径再变也只改这一个文件。</p>
 *
 * <p><b>本类只做「读取 + 兜底」，不做任何口径换算</b>：消息合计与请求开销减法由 {@code TokenAuditReconciler}（Pitest 扫描区）里。
 * 这里出现算术就意味着质量门禁扫不到，属于设计禁止的做法。</p>
 *
 * <p>工具总量已含调用参数。用户附件单列，记忆正文仍随系统消息结算。</p>
 *
 * <p><b>模型输入总量（U1 决策）</b>：取 {@code Session.contextTokenCount} —— 它与框架终态时的
 * {@code Execution.getContextUsageMetric()} 同源（由 {@code SessionContextUsageProjector} 写入），
 * 不自行估算、不抄框架实现细节。拿不到时传 0，由换算器退化成「请求开销 = 0」，
 * 绝不允许出现巨大负残差。上限同理取 {@code Session.contextMaxTokens}。</p>
 */
@Slf4j
@Component
public class TokenAuditConverter {

    /**
     * 转换（无调用条数来源）。{@code callCount} 一律为 0。
     *
     * <p><b>为什么没有条数</b>：框架审计文档里没有消息列表，{@code ToolElement} 只有
     * argument / output / total 三个量，无法反推调用条数。不凭空造数——
     * 需要「N 项」徽标时由接线方通过
     * {@link #toMeasurement(TokenAuditDocument, Session, Map)} 传入真实条数。</p>
     *
     * @param document 框架审计文档，可为 {@code null}（视为全 0）
     * @param session  产出该快照的会话，可为 {@code null}（此时总量与上限未知，均为 0）
     * @return 领域测量值
     */
    public Measurement toMeasurement(TokenAuditDocument document, Session session) {
        return toMeasurement(document, session, Map.of());
    }

    /**
     * 转换（带调用条数来源）。
     *
     * @param document       框架审计文档，可为 {@code null}
     * @param session        产出该快照的会话，可为 {@code null}
     * @param toolCallCounts 工具名 → 调用条数；缺省的工具名按 0 条计。可为 {@code null}
     * @return 领域测量值
     */
    public Measurement toMeasurement(TokenAuditDocument document, Session session,
                                     Map<String, Integer> toolCallCounts) {
        Map<String, Integer> counts = toolCallCounts == null ? Map.of() : toolCallCounts;
        if (document == null) {
            return new Measurement(0, 0, 0, 0, 0, liveTotalTokens(session), liveMaxTokens(session),
                    List.of(), null, null);
        }
        ToolParts tool = toolParts(document.toolTokens(), counts);
        return new Measurement(
                intValueOf(document.systemTokens()),
                intValueOf(document.userTokens()),
                intValueOf(document.assistantTokens()),
                tool.toolTokens(),
                tool.argumentTokens(),
                liveTotalTokens(session),
                liveMaxTokens(session),
                tool.groups(),
                toolDefinitionTokensOf(document),
                mcpToolDefinitionTokensOf(document),
                memoryTokensOf(document),
                attachmentTokensOf(document));
    }

    /**
     * 随请求下发的工具定义 token（框架 {@code e9c6ec6} 新增）。
     *
     * <p><b>未知必须保持 null</b>：{@code otherTokens} 整体缺失、元素为 {@code null}、
     * 状态不是 {@code SUCCESS}（{@code NO_DATA} / {@code FAILED}）都表示「框架没给出」。
     * 这时候写 0 会让前端画出一条「工具定义 0 token」的假柱子，比缺数据更糟。</p>
     *
     * @param document 框架审计文档
     * @return 非负值；未知时为 null
     */
    private static Integer toolDefinitionTokensOf(TokenAuditDocument document) {
        OtherTokens other = document.otherTokens();
        return other == null ? null : nullableIntOf(other.toolDefinitionTokens());
    }

    /**
     * 随请求下发的 MCP 工具定义 token；未知（缺失 / 未成功）时为 null。
     *
     * @param document 框架审计文档
     * @return 非负值；未知时为 null
     */
    private static Integer mcpToolDefinitionTokensOf(TokenAuditDocument document) {
        OtherTokens other = document.otherTokens();
        return other == null ? null : nullableIntOf(other.mcpToolDefinitionTokens());
    }

    /**
     * 记忆正文 token（框架 {@code OtherTokens.memoryTokens}）：<b>归因明细</b>，
     * 框架已把它并入 systemTokens，这里只读取、不参与任何换算。
     *
     * <p>业务侧当前不往 systemPrompt 拼记忆正文（记忆走「容量提醒 + 按需 wiki 工具」），
     * 因此该值通常为 0；但 0 是真实测量结果，与「null（未知）」必须区分开。</p>
     *
     * @param document 框架审计文档
     * @return 非负值；未知时为 null
     */
    private static Integer memoryTokensOf(TokenAuditDocument document) {
        OtherTokens other = document.otherTokens();
        return other == null ? null : nullableIntOf(other.memoryTokens());
    }

    /**
     * 独立计数的用户附件 token。
     *
     * @param document 框架审计文档
     * @return 非负值；未知时为 null
     */
    private static Integer attachmentTokensOf(TokenAuditDocument document) {
        OtherTokens other = document.otherTokens();
        return other == null ? null : nullableIntOf(other.attachmentTokens());
    }

    /**
     * 可空整数的元素读取：只认 {@code SUCCESS} 且带载荷的元素，其余一律返回 null。
     *
     * <p>框架给出负数说明数据异常，此处按「未知」处理而不是夹成 0，也不是抛错 ——
     * 夹成 0 会造假数据，抛错会让一次脏数据毁掉整份快照。</p>
     *
     * @param element 文档元素，可为 null
     * @return 非负值；未知时为 null
     */
    private static Integer nullableIntOf(DocumentElement<Integer> element) {
        Integer value = metaOf(element);
        if (value == null || value < 0) {
            return null;
        }
        return value;
    }

    /**
     * 工具视图：分组 + 参数合计 + 框架工具总量。
     *
     * @param element 框架工具文档元素
     * @param counts  工具名 → 调用条数
     * @return 三部分；框架没给（{@code null} / 非 {@code SUCCESS}）时全 0 且无分组
     */
    private ToolParts toolParts(DocumentElement<ToolAuditDocument> element, Map<String, Integer> counts) {
        ToolAuditDocument document = metaOf(element);
        if (document == null) {
            return new ToolParts(0, 0, List.of());
        }
        List<GroupMeasurement> groups = new ArrayList<>(3);
        int arguments = 0;
        GroupMeasurement mcp = namedGroup(TokenAuditGroupKind.MCP, document.mcpDetail());
        if (mcp != null) {
            groups.add(mcp);
            arguments += mcp.argumentTokens();
        }
        GroupMeasurement skill = namedGroup(TokenAuditGroupKind.SKILL, document.skillDetail());
        if (skill != null) {
            groups.add(skill);
            arguments += skill.argumentTokens();
        }
        GroupMeasurement ordinary = ordinaryGroup(document.tokenDetails(), counts);
        if (ordinary != null) {
            groups.add(ordinary);
            arguments += ordinary.argumentTokens();
        }
        return new ToolParts(nonNegative(document.toolTokens()), arguments, List.copyOf(groups));
    }

    /** MCP / SKILL 分组：框架只给聚合三元组，没有工具名明细，也没有条数。 */
    private GroupMeasurement namedGroup(TokenAuditGroupKind kind,
                                        DocumentElement<ToolElement> element) {
        ToolElement tool = metaOf(element);
        if (tool == null) {
            return null;
        }
        return new GroupMeasurement(kind,
                nonNegative(tool.totalTokens()),
                nonNegative(tool.argumentTokens()),
                nonNegative(tool.outputTokens()),
                0,
                List.of());
    }

    /** 普通工具分组：按工具名逐条下钻，分组值取各工具名之和（与恒等式 4 一致）。 */
    private GroupMeasurement ordinaryGroup(Map<String, ToolElement> details,
                                            Map<String, Integer> counts) {
        if (details == null || details.isEmpty()) {
            return null;
        }
        Map<String, ItemMeasurement> merged = new LinkedHashMap<>();
        for (Map.Entry<String, ToolElement> entry : details.entrySet()) {
            ToolElement tool = entry.getValue();
            if (tool == null) {
                continue;
            }
            String name = normalizeName(entry.getKey());
            ItemMeasurement item = new ItemMeasurement(name,
                    nonNegative(tool.totalTokens()),
                    nonNegative(tool.argumentTokens()),
                    nonNegative(tool.outputTokens()),
                    nonNegative(counts.getOrDefault(name, 0)));
            merged.merge(name, item, TokenAuditConverter::mergeItem);
        }
        if (merged.isEmpty()) {
            return null;
        }
        int total = 0;
        int arguments = 0;
        int output = 0;
        int calls = 0;
        for (ItemMeasurement item : merged.values()) {
            total += item.totalTokens();
            arguments += item.argumentTokens();
            output += item.outputTokens();
            calls += item.callCount();
        }
        return new GroupMeasurement(TokenAuditGroupKind.ORDINARY, total, arguments, output, calls,
                List.copyOf(merged.values()));
    }

    /** 同名工具（大小写或空白差异被归一后相撞）合并为一条，保持「一行一个工具名」。 */
    private static ItemMeasurement mergeItem(ItemMeasurement left, ItemMeasurement right) {
        return new ItemMeasurement(left.toolName(),
                left.totalTokens() + right.totalTokens(),
                left.argumentTokens() + right.argumentTokens(),
                left.outputTokens() + right.outputTokens(),
                left.callCount() + right.callCount());
    }

    /** 只接受 {@code SUCCESS} 且带载荷的元素：{@code NO_DATA} / {@code FAILED} 一律按「没有」处理。 */
    private static <T> T metaOf(DocumentElement<T> element) {
        if (element == null || element.getStatus() != AuditStatus.SUCCESS) {
            return null;
        }
        return element.getTokenMeta();
    }

    private static int intValueOf(DocumentElement<Integer> element) {
        Integer value = metaOf(element);
        return value == null ? 0 : nonNegative(value);
    }

    /**
     * 模型输入总量（U1）：取会话上下文用量，与框架终态 {@code ContextUsageMetric} 同源。
     *
     * @return 非负总量；会话缺失或尚未采集时为 0（由换算器退化为「请求开销 = 0」）
     */
    private static int liveTotalTokens(Session session) {
        if (session == null || session.getContextTokenCount() == null) {
            return 0;
        }
        return clamp(session.getContextTokenCount());
    }

    /** 上下文上限；会话缺失或未知时为 0（换算器据此把比率置空而不是除零）。 */
    private static int liveMaxTokens(Session session) {
        if (session == null || session.getContextMaxTokens() == null) {
            return 0;
        }
        return nonNegative(session.getContextMaxTokens());
    }

    /** 框架给负数说明数据异常；按 0 处理而不是抛错，避免一次脏数据毁掉整份快照。 */
    private static int nonNegative(int value) {
        return Math.max(value, 0);
    }

    /** 超出 int 范围时饱和，避免 Long → int 静默截断成负数。 */
    private static int clamp(long value) {
        if (value < 0) {
            return 0;
        }
        return value > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) value;
    }

    /** 与领域层同一套工具名归一规则（空白兜底为 {@code unknown_tool}）。 */
    private static String normalizeName(String toolName) {
        if (toolName == null || toolName.isBlank()) {
            return com.summit.dp.session.domain.model.TokenAuditReconciler.UNKNOWN_TOOL_NAME;
        }
        return toolName.strip();
    }

    /** 工具视图的三部分（框架类型在本层消化掉，不外泄）。 */
    private record ToolParts(int toolTokens, int argumentTokens, List<GroupMeasurement> groups) {
    }
}
