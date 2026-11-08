package com.summit.dp.session.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.Getter;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;

/**
 * 会话级 token 审计快照（聚合根）：一个会话只保留最近一次采集的事实。
 *
 * <p><b>为什么不落「比率」</b>：比率是展示派生值，父级为 0 时必须为 null 而不是 0 或 NaN；
 * 落库只会把某一刻的父级固化成永久错误。查询期现算，永远与当次分项一致。</p>
 *
 * <p><b>{@code CAPTURING} 不落库</b>：它是「此刻快照总量与实时总量是否相等」的判定，
 * 落库即过期。持久层只承认 {@link TokenAuditPersistedState#COLLECTED} /
 * {@link TokenAuditPersistedState#FAILED} 两种事实。</p>
 */
@Getter
public class SessionTokenAudit {

    /** 失败原因长度上限，与 {@code session_token_audit.fail_reason VARCHAR(512)} 一致。 */
    public static final int MAX_FAIL_REASON_LENGTH = 512;

    /** 框架没给失败原因时的兜底文案（中文业务文案，直接给用户看）。 */
    private static final String DEFAULT_FAIL_REASON = "token 审计采集失败";

    private final Long sessionId;
    /** 产出这份快照的执行；归属解析失败时为 null（此时只落库、不广播）。 */
    private final Long executionId;
    private TokenAuditPersistedState state;
    /** 框架口径的模型输入总量（消息 + 工具定义 + 请求框架）。 */
    private Integer totalTokens;
    /** 审计当时的上下文上限；null 表示未知。 */
    private final Integer maxTokens;
    /** 四类分项之和（去重叠口径）。 */
    private Integer messagesTokens;
    /** 非消息请求开销，由减法得出，可能为负。 */
    private Integer requestOverheadTokens;
    /** 工具调用参数 token：已计入 AI 项，仅说明。 */
    private Integer overlapTokens;
    /**
     * 归因漂移（有符号）：采集时的「框架自报工具总量 − 各分组展示值之和」。
     *
     * <p><b>为什么必须落库</b>：恒等式 3 要求 TOOL 行 = Σ分组，因此该差在库内<b>恒等于 0</b>，
     * 读库无法复算。它是分组归因写错时的绊线（会先变大而 {@code requestOverhead} 不响），
     * 只能在采集瞬间算出来并存下来。</p>
     */
    private Integer toolGroupingDrift;
    /**
     * 随请求下发的工具定义 token（框架 {@code e9c6ec6} 的 {@code OtherTokens}）。
     *
     * <p><b>null 表示「未知」</b>（框架未给出 / 该项审计失败），绝不能用 0 顶替：
     * 0 会让前端画出一条不存在的「工具定义零开销」。
     * 与 {@link #mcpToolDefinitionTokens} 一起构成恒等式 B 的两项已知开销。</p>
     */
    private Integer toolDefinitionTokens;
    /** 随请求下发的 MCP 工具定义 token；null 表示未知（同 {@link #toolDefinitionTokens}）。 */
    private Integer mcpToolDefinitionTokens;
    /**
     * 记忆正文 token（框架 {@code e9c6ec6} 的 {@code OtherTokens.memoryTokens}）。
     *
     * <p><b>归因明细，不是独立开销</b>：框架已把它并入 {@code SYSTEM} 分项，因此
     * <b>绝不能加到 {@link #messagesTokens}、{@link #requestOverheadTokens} 或 {@link #totalTokens} 上</b>，
     * 也不能参与任何恒等式。它只回答「SYSTEM 里有多少是记忆正文」。</p>
     *
     * <p>null 表示「未知」（框架未给出 / 该元素审计失败），不用 0 顶替。</p>
     */
    private Integer memoryTokens;
    /**
     * 用户附件 token（框架 {@code e9c6ec6} 的 {@code OtherTokens.attachmentTokens}）。
     *
     * <p>同 {@link #memoryTokens}：<b>已并入 {@code USER} 分项，纯归因明细，禁止累加</b>。</p>
     */
    private Integer attachmentTokens;
    private Instant capturedAt;
    private String failReason;
    private final List<SessionTokenAuditItem> items;

    private SessionTokenAudit(Long sessionId, Long executionId, TokenAuditPersistedState state,
                              Integer totalTokens, Integer maxTokens, Integer messagesTokens,
                              Integer requestOverheadTokens, Integer overlapTokens,
                              Integer toolGroupingDrift, Integer toolDefinitionTokens,
                              Integer mcpToolDefinitionTokens, Integer memoryTokens,
                              Integer attachmentTokens, Instant capturedAt,
                              String failReason, List<SessionTokenAuditItem> items) {
        if (sessionId == null) {
            throw new ClientException("token 审计快照必须归属一个会话");
        }
        this.sessionId = sessionId;
        this.executionId = executionId;
        this.state = Objects.requireNonNullElse(state, TokenAuditPersistedState.COLLECTED);
        this.totalTokens = totalTokens;
        this.maxTokens = maxTokens;
        this.messagesTokens = messagesTokens;
        this.requestOverheadTokens = requestOverheadTokens;
        this.overlapTokens = overlapTokens;
        this.toolGroupingDrift = toolGroupingDrift;
        this.toolDefinitionTokens = toolDefinitionTokens;
        this.mcpToolDefinitionTokens = mcpToolDefinitionTokens;
        this.memoryTokens = memoryTokens;
        this.attachmentTokens = attachmentTokens;
        this.capturedAt = capturedAt;
        this.failReason = failReason;
        this.items = new ArrayList<>(Objects.requireNonNullElse(items, List.of()));
    }

    /**
     * 用换算结果构造一份成功快照。
     *
     * @param sessionId  会话标识，不能为空
     * @param executionId 产出快照的执行，可为 null
     * @param result     口径换算结果，不能为空
     * @param capturedAt 采集时刻；null 取当前时间
     * @return 状态为 {@link TokenAuditPersistedState#COLLECTED} 的快照
     */
    public static SessionTokenAudit capture(Long sessionId, Long executionId,
                                            TokenAuditReconciler.Result result, Instant capturedAt) {
        if (result == null) {
            throw new ClientException("token 审计换算结果不能为空");
        }
        return new SessionTokenAudit(sessionId, executionId, TokenAuditPersistedState.COLLECTED,
                result.totalTokens(), toMaxTokens(result.maxTokens()), result.messagesTokens(),
                result.requestOverheadTokens(), result.overlapTokens(), result.toolGroupingDrift(),
                result.toolDefinitionTokens(), result.mcpToolDefinitionTokens(),
                result.memoryTokens(), result.attachmentTokens(),
                Objects.requireNonNullElseGet(capturedAt, Instant::now), null, result.items());
    }

    /**
     * 构造一份失败快照：只保留失败原因与时间，数值一律留空。
     *
     * <p>为什么把数值清空：{@code FAILED} 时若还留着上一次的数字，前端会把它当成「当前构成」
     * 画出来；用 0 冒充同样误导。失败就是「不知道」，必须显式留空。</p>
     *
     * @param sessionId   会话标识，不能为空
     * @param executionId 失败所在执行，可为 null
     * @param reason      失败原因；空值使用兜底文案，超长截断到 {@link #MAX_FAIL_REASON_LENGTH}
     * @param capturedAt  失败时刻；null 取当前时间
     */
    public static SessionTokenAudit failure(Long sessionId, Long executionId, String reason,
                                            Instant capturedAt) {
        return new SessionTokenAudit(sessionId, executionId, TokenAuditPersistedState.FAILED,
                null, null, null, null, null, null, null, null, null, null,
                Objects.requireNonNullElseGet(capturedAt, Instant::now),
                normalizeFailReason(reason), List.of());
    }

    /**
     * 仓储重建：完全按库里的值还原，不做状态重算，否则读一次就可能改写事实。
     */
    public static SessionTokenAudit restore(Long sessionId, Long executionId,
                                            TokenAuditPersistedState state, Integer totalTokens,
                                            Integer maxTokens, Integer messagesTokens,
                                            Integer requestOverheadTokens, Integer overlapTokens,
                                            Integer toolGroupingDrift, Integer toolDefinitionTokens,
                                            Integer mcpToolDefinitionTokens, Integer memoryTokens,
                                            Integer attachmentTokens, Instant capturedAt,
                                            String failReason, List<SessionTokenAuditItem> items) {
        return new SessionTokenAudit(sessionId, executionId, state, totalTokens, maxTokens,
                messagesTokens, requestOverheadTokens, overlapTokens, toolGroupingDrift,
                toolDefinitionTokens, mcpToolDefinitionTokens, memoryTokens, attachmentTokens,
                capturedAt, failReason, items);
    }

    /**
     * 把快照置为失败。
     *
     * <p><b>已有成功快照时绝不生效</b>：一次失败的采集不该摧毁手上唯一可解释的事实，
     * 用户宁可看到「旧快照 + 正在采集」，也不要看到一份空白面板。</p>
     *
     * @param reason 失败原因；空值使用兜底文案，超长截断
     */
    public void changeFailed(String reason) {
        if (state == TokenAuditPersistedState.COLLECTED) {
            return;
        }
        this.state = TokenAuditPersistedState.FAILED;
        this.totalTokens = null;
        this.messagesTokens = null;
        this.requestOverheadTokens = null;
        this.overlapTokens = null;
        this.toolGroupingDrift = null;
        this.toolDefinitionTokens = null;
        this.mcpToolDefinitionTokens = null;
        this.memoryTokens = null;
        this.attachmentTokens = null;
        this.failReason = normalizeFailReason(reason);
        this.capturedAt = Instant.now();
        this.items.clear();
    }

    /**
     * 请求框架残差（恒等式 5 的派生值，<b>不落库</b>）：请求开销 − 工具定义 − MCP 工具定义。
     *
     * <p>与采集期同一套减法（{@link TokenAuditReconciler#framingResidual}），保证「采集时算的」
     * 与「查询时算的」不可能漂移。任一项未知即整体未知（null），不拿部分已知去凑数。</p>
     *
     * @return 残差（可负）；任一项为 null 时返回 null
     */
    public Integer framingResidualTokens() {
        return TokenAuditReconciler.framingResidual(requestOverheadTokens, toolDefinitionTokens,
                mcpToolDefinitionTokens);
    }

    /**
     * 判断一个「后续到达的采集」是否允许覆盖本快照。
     *
     * <p>规则：更晚的采集覆盖；更早的不覆盖；采集时刻相同（毫秒截断后很常见）时按执行 id 大的胜出，
     * 保证同一时刻的重复投递是幂等而非随机。</p>
     *
     * @param incomingCapturedAt  新采集的时刻，null 视为不可用
     * @param incomingExecutionId 新采集的执行 id，可为 null
     * @return {@code true} 表示允许覆盖
     */
    public boolean shouldReplace(Instant incomingCapturedAt, Long incomingExecutionId) {
        if (incomingCapturedAt == null) {
            return false;
        }
        if (capturedAt == null) {
            return true;
        }
        int order = incomingCapturedAt.compareTo(capturedAt);
        if (order != 0) {
            return order > 0;
        }
        if (incomingExecutionId == null) {
            return false;
        }
        if (executionId == null) {
            return true;
        }
        return incomingExecutionId.longValue() > executionId.longValue();
    }

    /**
     * 取某一类消息分项。
     *
     * @param category 分类
     * @return 命中行；无快照（{@code NOT_COLLECTED} / {@code FAILED}）时返回 {@code null}，
     *         由查询服务补 4 条 0 值行，前端不必判空
     */
    public SessionTokenAuditItem messagesOf(TokenAuditCategory category) {
        if (category == null) {
            return null;
        }
        for (SessionTokenAuditItem item : items) {
            if (item.getLevel() == TokenAuditItemLevel.MESSAGE && item.getCategory() == category) {
                return item;
            }
        }
        return null;
    }

    /**
     * 派生对外展示态。
     *
     * @param liveTotal 会话实时总量（{@code Session.contextTokenCount}），可为 null（尚未采集）
     * @return 四值之一：{@code FAILED} 优先于任何数值判定
     */
    public TokenAuditDisplayState resolveDisplayState(Long liveTotal) {
        if (state == TokenAuditPersistedState.FAILED) {
            return TokenAuditDisplayState.FAILED;
        }
        if (totalTokens == null) {
            return TokenAuditDisplayState.NOT_COLLECTED;
        }
        if (liveTotal == null) {
            // 实时总量未知时不能凭空说「在采集」，快照本身是唯一可信事实。
            return TokenAuditDisplayState.COLLECTED;
        }
        return liveTotal.longValue() == totalTokens.intValue()
                ? TokenAuditDisplayState.COLLECTED
                : TokenAuditDisplayState.CAPTURING;
    }

    /**
     * 实时总量与快照总量的差值（正=已涨、负=已缩）。
     *
     * @param liveTotal 实时总量，可为 null
     * @return 差值；任一侧缺失时返回 {@code null}（0 会被误读成「对得齐」）
     */
    public Integer driftTokens(Long liveTotal) {
        if (liveTotal == null || totalTokens == null) {
            return null;
        }
        return (int) (liveTotal.longValue() - totalTokens.intValue());
    }

    /**
     * 快照总量占上下文上限的比例（可 &gt; 1 表示超限，不截断）。
     *
     * @return 比例；上限未知或 &lt;= 0 时返回 {@code null}
     */
    public Double ratio() {
        if (totalTokens == null || maxTokens == null || maxTokens <= 0) {
            return null;
        }
        return (double) totalTokens.intValue() / maxTokens.intValue();
    }

    /** 工具分组行，按 sort_order 升序。 */
    public List<SessionTokenAuditItem> toolGroups() {
        return itemsOfLevel(TokenAuditItemLevel.TOOL_GROUP);
    }

    /** 普通工具明细行，按 sort_order 升序。 */
    public List<SessionTokenAuditItem> toolItems() {
        return itemsOfLevel(TokenAuditItemLevel.TOOL_ITEM);
    }

    /**
     * TOOL 项的展示值 = 各工具分组展示值之和（子项优先，与 TOOL 消息行同口径）。
     *
     * @return 展示值；无工具时 0
     */
    public Integer toolTokens() {
        int sum = 0;
        for (SessionTokenAuditItem group : toolGroups()) {
            sum += group.resultTokens();
        }
        return sum;
    }

    /**
     * 归因漂移（字段 {@link #toolGroupingDrift}，由 {@code @Getter} 暴露为
     * {@code getToolGroupingDrift()}）。
     *
     * <p>值来自采集瞬间（{@code TokenAuditReconciler.Result#toolGroupingDrift()}）并已落库，
     * 读库拿到的就是真值。<b>不要再按「TOOL 行 − Σ分组」由库内数据派生</b>：恒等式 3 要求
     * TOOL 行 = Σ分组，派生结果恒为 0，会把这条归因绊线变成死数据。</p>
     */

    /** 明细行只读视图：调用方不能借返回的集合改聚合内部状态。 */
    public List<SessionTokenAuditItem> getItems() {
        return List.copyOf(items);
    }

    private List<SessionTokenAuditItem> itemsOfLevel(TokenAuditItemLevel level) {
        List<SessionTokenAuditItem> matched = new ArrayList<>();
        for (SessionTokenAuditItem item : items) {
            if (item.getLevel() == level) {
                matched.add(item);
            }
        }
        matched.sort(Comparator.comparingInt(SessionTokenAuditItem::getSortOrder));
        return matched;
    }

    /** 上限为 0 表示「框架没给」，落库写成 null 才能与「真的 0 上限」区分。 */
    private static Integer toMaxTokens(int maxTokens) {
        return maxTokens > 0 ? maxTokens : null;
    }

    /** 截断写在领域方法里，PO / VO 一律不做长度处理（否则两处规则必然漂移）。 */
    private static String normalizeFailReason(String reason) {
        if (reason == null || reason.isBlank()) {
            return DEFAULT_FAIL_REASON;
        }
        String stripped = reason.strip();
        return stripped.length() <= MAX_FAIL_REASON_LENGTH
                ? stripped : stripped.substring(0, MAX_FAIL_REASON_LENGTH);
    }
}
