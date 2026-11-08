package com.summit.dp.session.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.SessionTokenAuditItem;
import com.summit.dp.session.domain.model.TokenAuditCategory;
import com.summit.dp.session.domain.model.TokenAuditDisplayState;
import com.summit.dp.session.domain.model.TokenAuditGroupKind;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionTokenAuditVO;
import com.summit.dp.shared.vo.TokenAuditCategoryVO;
import com.summit.dp.shared.vo.TokenAuditContextAttributionVO;
import com.summit.dp.shared.vo.TokenAuditOverheadItemVO;
import com.summit.dp.shared.vo.TokenAuditReconciliationVO;
import com.summit.dp.shared.vo.TokenAuditRequestOverheadVO;
import com.summit.dp.shared.vo.TokenAuditToolBreakdownVO;
import com.summit.dp.shared.vo.TokenAuditToolGroupVO;
import com.summit.dp.shared.vo.TokenAuditToolItemVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

/**
 * token 审计查询：把「库里的快照」与「会话的实时上下文用量」拼成对外视图。
 *
 * <p><b>两路数据必须分开表达</b>：分项来自最近一次成功采集（终态事实），
 * 总量来自 {@code Session.contextTokenCount}（实时）。两者的差就是
 * {@code driftTokens}，而「是否还在追」由 {@code displayState} 显式表达，
 * 前端不需要自己判断容差。</p>
 *
 * <p><b>比率一律现算不落库</b>：父级为 0 / 缺失时返回 {@code null}
 * （返回 0 或 NaN 都会让前端画出误导性条形）。</p>
 */
@Service
@RequiredArgsConstructor
public class SessionTokenAuditQueryService {

    /** 四类分项固定顺序与固定条数，前端不必判空。 */
    private static final int CATEGORY_COUNT = 4;

    private final SessionTokenAuditRepository auditRepository;
    private final SessionRepository sessionRepository;

    /**
     * 查询接口：会话不存在直接报错（用户显式点名的入口，查不到就是业务失败）。
     *
     * @param sessionId 会话标识（根会话或子会话均可，审计按会话存、不向根会话聚合）
     * @return 统一信封包裹的审计视图
     * @throws ClientException 会话 ID 为空或会话不存在
     */
    public Result<SessionTokenAuditVO> find(Long sessionId) {
        if (sessionId == null) {
            throw new ClientException("会话ID不能为空");
        }
        Session session = sessionRepository.findById(sessionId).orElseThrow(
                () -> new ClientException("会话不存在: sessionId=" + sessionId));
        return Result.success(build(sessionId, session));
    }

    /**
     * 广播用快照：与 {@link #find(Long)} 同构，但会话查不到时不抛异常。
     *
     * <p>旁路动作（采集成功后推送）不该因为会话刚被删除而把整次采集判失败。</p>
     *
     * @param sessionId 会话标识
     * @return 审计视图；会话不存在时按「无实时数据」渲染
     * @throws ClientException 会话 ID 为空
     */
    public SessionTokenAuditVO snapshot(Long sessionId) {
        if (sessionId == null) {
            throw new ClientException("会话ID不能为空");
        }
        Session session = sessionRepository.findById(sessionId).orElse(null);
        return build(sessionId, session);
    }

    /**
     * 组装视图。
     *
     * @param sessionId 会话标识
     * @param session   会话实体，可为 {@code null}（此时实时量全部为空）
     * @return 审计视图
     */
    private SessionTokenAuditVO build(Long sessionId, Session session) {
        SessionTokenAudit audit = auditRepository.findBySessionId(sessionId).orElse(null);
        Integer liveTotal = liveTokensOf(session);
        Integer liveMax = session == null ? null : session.getContextMaxTokens();
        Integer messagesTotal = audit == null ? null : audit.getMessagesTokens();

        return SessionTokenAuditVO.builder()
                .sessionId(sessionId)
                .displayState(resolveDisplayState(audit, liveTotal).name())
                .liveTotalTokens(liveTotal)
                .liveMaxTokens(liveMax)
                .liveRatio(ratio(liveTotal, liveMax))
                .remainingTokens(remainingOf(liveTotal, liveMax))
                .remainingRatio(remainingRatio(remainingOf(liveTotal, liveMax), liveMax))
                .totalTokens(audit == null ? null : audit.getTotalTokens())
                .driftTokens(audit == null ? null : audit.driftTokens(asLongOrNull(liveTotal)))
                .capturedAt(audit == null ? null : audit.getCapturedAt())
                .failReason(audit == null ? null : audit.getFailReason())
                .reconciliation(reconciliationOf(audit))
                .contextAttribution(contextAttributionOf(audit))
                .requestOverhead(requestOverheadOf(audit, messagesTotal))
                .messages(categoryViews(audit, messagesTotal))
                .messagesTotalTokens(messagesTotal)
                .tools(toolsOf(audit, messagesTotal))
                .build();
    }

    /**
     * 实时已用 token：{@code Session} 侧是 {@code Long}（列是 BIGINT，与历史数据一致），
     * 对外 VO 一律 {@code Integer}（见 {@code SessionTokenAuditVO#liveTotalTokens} 的说明）。
     *
     * <p><b>为什么这里必须显式收敛而不是直接强转</b>：{@code Long} 自动拆箱成 {@code int}
     * 会静默截断（超过 int 上限时变负数，前端会画出负的构成）。token 实际不可能超限，
     * 但这个转换点是唯一可能出错的地方，因此做饱和处理而不是让它悄悄溢出。</p>
     *
     * @param session 会话实体，可为 {@code null}
     * @return 非负的已用 token；会话缺失或尚未采集时为 {@code null}（未知，不是 0）
     */
    private static Integer liveTokensOf(Session session) {
        if (session == null || session.getContextTokenCount() == null) {
            return null;
        }
        long value = session.getContextTokenCount();
        if (value < 0) {
            return null;
        }
        return value > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) value;
    }

    /**
     * 领域层仍以 {@code Long} 接收实时总量（它同时服务于 {@code Session} 的 BIGINT 口径），
     * 这里只做一次无损扩大转换。
     *
     * @param tokens 已收敛的 token 数，可为 {@code null}
     * @return 对应的 {@code Long}；入参为 {@code null} 时返回 {@code null}
     */
    private static Long asLongOrNull(Integer tokens) {
        return tokens == null ? null : tokens.longValue();
    }

    /**
     * 剩余可用 token（设计稿「剩余可用 51,800 tok」）。
     *
     * <p><b>null 判断必须走 Integer 的引用比较</b>：任一为 {@code null} 就整体返回 {@code null}，
     * 绝不能让「上限未知」被拆箱成 0 或算出 {@code 0 − used} 的负数。</p>
     *
     * @param liveTotal 实时已用，可为 null
     * @param liveMax   上下文上限，可为 null
     * @return {@code liveMax − liveTotal}（超限时为负，如实给出）；任一为 null 时返回 null
     */
    private static Integer remainingOf(Integer liveTotal, Integer liveMax) {
        if (liveTotal == null || liveMax == null) {
            return null;
        }
        return liveMax - liveTotal;
    }

    /**
     * 剩余占比（设计稿「25.9%」）。
     *
     * @param remaining 剩余量，可为 null
     * @param liveMax   上限，可为 null
     * @return {@code remaining / liveMax}；上限缺失或 {@code <= 0} 时返回 null（不除零）
     */
    private static Double remainingRatio(Integer remaining, Integer liveMax) {
        if (remaining == null || liveMax == null || liveMax <= 0) {
            return null;
        }
        return remaining.doubleValue() / liveMax.doubleValue();
    }

    /**
     * 设计稿的「其他消息」面板：非消息请求开销的构成。
     *
     * <p><b>口径逐条对齐设计稿</b>：</p>
     * <ul>
     *   <li>父项占比分母是 {@code messagesTotalTokens}（15,200 / 142,850 = 10.6%），
     *       不是 {@code totalTokens}；</li>
     *   <li>两个子项占比分母是<b>父项自身</b>（10,400 / 15,200 = 68.4%）；</li>
     *   <li>子项缺失即整个子对象不下发，{@code itemCount} 相应减少；</li>
     *   <li>{@code framingResidualTokens} 如实下发（前端「非 0 才渲染第三行」）。</li>
     * </ul>
     *
     * <p>数值与 {@link #reconciliationOf(SessionTokenAudit)} 同源（同一组落库列），
     * 不存在两处各算一遍的可能。</p>
     *
     * @param audit          快照，可为 null
     * @param messagesTotal  四类之和，可为 null
     * @return 构成视图；无快照 / 总量未知 / 请求开销未知时为 null
     */
    private static TokenAuditRequestOverheadVO requestOverheadOf(SessionTokenAudit audit,
                                                                 Integer messagesTotal) {
        if (audit == null || audit.getTotalTokens() == null
                || audit.getRequestOverheadTokens() == null) {
            return null;
        }
        Integer overhead = audit.getRequestOverheadTokens();
        TokenAuditOverheadItemVO toolDefinition = overheadItem(audit.getToolDefinitionTokens(), overhead);
        TokenAuditOverheadItemVO mcpDefinition =
                overheadItem(audit.getMcpToolDefinitionTokens(), overhead);
        int itemCount = 0;
        if (toolDefinition != null) {
            itemCount++;
        }
        if (mcpDefinition != null) {
            itemCount++;
        }
        return TokenAuditRequestOverheadVO.builder()
                .tokens(overhead)
                .ratio(ratio(overhead, messagesTotal))
                .itemCount(itemCount)
                .toolDefinition(toolDefinition)
                .mcpToolDefinition(mcpDefinition)
                .framingResidualTokens(audit.framingResidualTokens())
                .build();
    }

    /**
     * 单个工具定义子项。
     *
     * @param tokens   子项 token，可为 null（框架未给出）
     * @param overhead 父项「其他消息」总量，可为 null
     * @return 子项视图；{@code tokens} 为 null 时返回 null（<b>整个子项不下发</b>，不造 0 值行）
     */
    private static TokenAuditOverheadItemVO overheadItem(Integer tokens, Integer overhead) {
        if (tokens == null) {
            return null;
        }
        return TokenAuditOverheadItemVO.builder()
                .tokens(tokens)
                .ratio(ratio(tokens, overhead))
                .build();
    }

    /** 没有任何快照行时是 {@code NOT_COLLECTED}；有行则交给聚合自己判（FAILED 优先）。 */
    private static TokenAuditDisplayState resolveDisplayState(SessionTokenAudit audit, Integer liveTotal) {
        return audit == null
                ? TokenAuditDisplayState.NOT_COLLECTED
                : audit.resolveDisplayState(asLongOrNull(liveTotal));
    }

    /** 差额解释：总量缺失（失败 / 未采集）时为 null，避免前端把 0 当成「开销为 0」。 */
    private static TokenAuditReconciliationVO reconciliationOf(SessionTokenAudit audit) {
        if (audit == null || audit.getTotalTokens() == null) {
            return null;
        }
        return TokenAuditReconciliationVO.builder()
                .totalTokens(audit.getTotalTokens())
                .messagesTokens(audit.getMessagesTokens())
                .requestOverheadTokens(audit.getRequestOverheadTokens())
                .argumentOverlapTokens(audit.getOverlapTokens())
                .toolGroupingDrift(audit.getToolGroupingDrift())
                .toolDefinitionTokens(audit.getToolDefinitionTokens())
                .mcpToolDefinitionTokens(audit.getMcpToolDefinitionTokens())
                .framingResidualTokens(audit.framingResidualTokens())
                .build();
    }

    /**
     * 上下文归因明细：记忆正文与用户附件。
     *
     * <p><b>刻意不并入任何分类或对账对象</b>：这两个值已分别包含在 SYSTEM / USER 合计中，
     * 只是「合计里有多少来自记忆 / 附件」的拆分说明。放进 {@code messages} 会让四类之和
     * 大于 {@code messagesTotalTokens}，放进 {@code reconciliation} 会破坏请求开销恒等式。</p>
     *
     * <p>两项都未知（null）时整体为 null，前端据此隐藏该块 —— 用 0 会画出「零开销」的假项。</p>
     *
     * @param audit 快照；无快照时为 null
     * @return 归因明细视图；两项皆未知时为 null
     */
    private static TokenAuditContextAttributionVO contextAttributionOf(SessionTokenAudit audit) {
        if (audit == null) {
            return null;
        }
        Integer memory = audit.getMemoryTokens();
        Integer attachment = audit.getAttachmentTokens();
        if (memory == null && attachment == null) {
            return null;
        }
        return TokenAuditContextAttributionVO.builder()
                .memoryTokens(memory)
                .attachmentTokens(attachment)
                .build();
    }

    /** 四类分项：恒为 4 条、固定顺序；无明细行时补 0 值行（比率仍为 null，不伪造占比）。 */
    private static List<TokenAuditCategoryVO> categoryViews(SessionTokenAudit audit,
                                                            Integer messagesTotal) {
        List<TokenAuditCategoryVO> views = new ArrayList<>(CATEGORY_COUNT);
        for (TokenAuditCategory category : TokenAuditCategory.values()) {
            SessionTokenAuditItem item = audit == null ? null : audit.messagesOf(category);
            views.add(TokenAuditCategoryVO.builder()
                    .type(category.name())
                    .tokens(item == null ? 0 : item.resultTokens())
                    .ratio(item == null ? null : item.ratioOf(messagesTotal))
                    .expandable(category == TokenAuditCategory.TOOL)
                    .build());
        }
        return views;
    }

    /** TOOL 下钻：没有任何工具分组时为 null（前端据此隐藏展开箭头）。 */
    private static TokenAuditToolBreakdownVO toolsOf(SessionTokenAudit audit, Integer messagesTotal) {
        if (audit == null) {
            return null;
        }
        List<SessionTokenAuditItem> groups = audit.toolGroups();
        if (groups.isEmpty()) {
            return null;
        }
        Integer toolTokens = audit.toolTokens();
        TokenAuditToolGroupVO mcp = null;
        TokenAuditToolGroupVO skill = null;
        TokenAuditToolGroupVO ordinary = null;
        for (SessionTokenAuditItem group : groups) {
            TokenAuditToolGroupVO view = groupView(audit, group, toolTokens);
            TokenAuditGroupKind kind = group.getGroupKind();
            if (kind == TokenAuditGroupKind.MCP) {
                mcp = view;
            } else if (kind == TokenAuditGroupKind.SKILL) {
                skill = view;
            } else if (kind == TokenAuditGroupKind.ORDINARY) {
                ordinary = view;
            }
        }
        return TokenAuditToolBreakdownVO.builder()
                .tokens(toolTokens)
                .ratio(ratio(toolTokens, messagesTotal))
                .mcp(mcp)
                .skill(skill)
                .ordinary(ordinary)
                .build();
    }

    /** 单个分组视图：比率以 TOOL 总量为父级；只有普通分组带工具名明细。 */
    private static TokenAuditToolGroupVO groupView(SessionTokenAudit audit, SessionTokenAuditItem group,
                                                    Integer toolTokens) {
        Integer groupTokens = group.resultTokens();
        List<TokenAuditToolItemVO> items = new ArrayList<>();
        if (group.getGroupKind() == TokenAuditGroupKind.ORDINARY) {
            for (SessionTokenAuditItem item : audit.toolItems()) {
                items.add(itemView(item, groupTokens));
            }
        }
        return TokenAuditToolGroupVO.builder()
                .groupKind(group.getGroupKind() == null ? null : group.getGroupKind().name())
                .tokens(groupTokens)
                .ratio(ratio(groupTokens, toolTokens))
                .items(items)
                .build();
    }

    /** 单个工具名视图：比率以所属普通分组为父级。 */
    private static TokenAuditToolItemVO itemView(SessionTokenAuditItem item, Integer groupTokens) {
        return TokenAuditToolItemVO.builder()
                .toolName(item.getToolName())
                .tokens(item.resultTokens())
                .ratio(item.ratioOf(groupTokens))
                .argumentTokens(item.getArgumentTokens())
                .outputTokens(item.getOutputTokens())
                .build();
    }

    /**
     * 比率：父级为 {@code null} 或 {@code <= 0} 时返回 {@code null}（不除零）。
     *
     * @param value  被除数，可为 {@code null}
     * @param parent 父级总量，可为 {@code null}
     * @return 比例，可 &gt; 1（超限不截断）
     */
    private static Double ratio(Number value, Integer parent) {
        if (value == null || parent == null || parent <= 0) {
            return null;
        }
        return value.doubleValue() / parent.doubleValue();
    }
}
