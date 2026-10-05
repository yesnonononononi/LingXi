package com.summit.dp.session.application.service;

import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.ExecutionStateVO;
import com.summit.dp.shared.vo.SessionBootstrapVO;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.SessionTreeVO;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.application.vo.ChatTurnVO;
import com.summit.dp.turn.domain.model.ChatTurn;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * bootstrap 同步装配（§8.2）：把「前端重连后需要一次性对齐的持久化状态」装进一个信封。
 *
 * <p><b>不新造读路径</b>：会话树复用 {@link SessionService#tree}，历史页复用
 * {@link SessionService#messages}，卡片复用 {@code ToolCallRepository} + {@link ToolCallConverter}，
 * 轮次复用 {@link ChatTurnService} + {@link ChatTurnConverter}，执行状态复用
 * {@link ExecutionQueryService}。查询次数由实体种类决定，不随片段 / 工具 / 子会话数量产生 N+1。</p>
 *
 * <p><b>未决卡片的执行闸门必须批量算</b>：逐卡调用
 * {@code CardAvailabilityPolicy.resolveExecutionGate(String)} 会对每张卡各查一次执行（§7 要删除的
 * N+1）。这里改为一次 {@code listByConversationId} + 一次 {@code summariesByIds}，
 * 在内存里把执行摘要状态映射成闸门。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class SessionBootstrapService {

    /** 历史首屏页大小；与前端首屏分页一致，翻页仍走原历史接口。 */
    private static final int HISTORY_PAGE_SIZE = 50;

    /**
     * 前后 historyRevision 检查的最大重读次数。
     *
     * <p>历史在读取过程中被改写（重发 / 新消息）时，前后代际不一致 → 有限重读；
     * 连续 {@value #MAX_REVISION_RETRIES} 次仍不稳定则放弃并报「历史正在变更」，
     * 让前端退避重连，而不是无限重试把库打满（§8）。</p>
     */
    private static final int MAX_REVISION_RETRIES = 3;

    private final SessionService sessionService;
    private final SessionAggregateService sessionAggregateService;
    private final ExecutionQueryService executionQueryService;
    private final ToolCallRepository toolCallRepository;
    private final ToolCallConverter toolCallConverter;
    private final ChatTurnService chatTurnService;
    private final ChatTurnConverter chatTurnConverter;

    /**
     * 装配 bootstrap 响应。
     *
     * <p>流程：解析根会话 →（读 historyRevision → 读会话树 + 历史页 → 复查 historyRevision）
     * 有限重读至代际稳定 → 装配未决卡片 / 进行中轮次 / 执行状态。</p>
     *
     * @param rootSessionId 根会话 id（或任意子会话 id，内部解析为根）
     */
    public SessionBootstrapVO bootstrap(Long rootSessionId) {
        if (rootSessionId == null) {
            throw new ClientException("会话ID不能为空");
        }
        // sessionTree 内部已 requireOwned（会话不存在会抛「会话不存在」，与历史接口一致），
        // 这里不再重复查一次存在性 —— 多一次读没有收益，还会干扰代际稳定性的前后配对。
        SessionAggregateService.SessionTree tree = sessionAggregateService.sessionTree(rootSessionId);
        Long rootId = tree.rootSessionId();

        // 一次稳定读取：前后 historyRevision 一致才接受；不稳定则有限重读。
        SessionTreeVO sessions = null;
        SessionMessagePageVO history = null;
        Long stableRevision = null;
        for (int attempt = 0; attempt < MAX_REVISION_RETRIES; attempt++) {
            Long before = sessionAggregateService.requireOwned(rootId).getHistoryRevision();
            SessionTreeVO treeVO = sessionService.tree(rootId).getData();
            SessionMessagePageVO historyVO = sessionService.messages(rootId, null, HISTORY_PAGE_SIZE).getData();
            Long after = sessionAggregateService.requireOwned(rootId).getHistoryRevision();
            if (before.equals(after)) {
                sessions = treeVO;
                history = historyVO;
                stableRevision = after;
                break;
            }
            log.warn("bootstrap 历史代际在读取中变更，重读: rootSessionId={}, before={}, after={}, attempt={}",
                    rootId, before, after, attempt + 1);
        }
        if (stableRevision == null) {
            throw new ClientException("历史正在变更，请重新加载");
        }

        List<Long> sessionIds = sessions.getSessions().stream().map(SessionVO::getId).toList();

        return SessionBootstrapVO.builder()
                .rootSessionId(rootId)
                .historyRevision(stableRevision)
                .sessions(sessions.getSessions())
                .history(history)
                .toolCalls(resolveUnresolvedCards(sessionIds))
                .turns(resolveActiveTurns(sessionIds))
                .executions(resolveExecutionStates(sessionIds))
                .build();
    }

    /**
     * 全部未决卡片：按会话树 id 逐个 {@code listByConversationId}（卡片读路径本来就按会话查），
     * 过滤 {@code isUnresolved()}，收集执行 id 后<b>一次</b>批量取摘要算闸门。
     *
     * <p>卡片查询按会话树 id 各一次、执行摘要一次 —— 查询次数 = 会话数 + 1，不随卡片数量增长，
     * 与「逐卡回查执行」的 N+1 是两回事。</p>
     */
    private List<ToolCallVO> resolveUnresolvedCards(List<Long> sessionIds) {
        List<ToolCall> unresolved = new ArrayList<>();
        Set<Long> executionIds = new LinkedHashSet<>();
        for (Long sessionId : sessionIds) {
            for (ToolCall tool : toolCallRepository.listByConversationId(sessionId)) {
                if (tool != null && tool.isUnresolved()) {
                    unresolved.add(tool);
                    if (tool.getExecutionId() != null) {
                        executionIds.add(tool.getExecutionId());
                    }
                }
            }
        }
        if (unresolved.isEmpty()) {
            return List.of();
        }
        // 一次批量取执行摘要（§7：绝不对每张卡单独回查执行）。
        Map<Long, ExecutionQueryService.ExecutionSummary> summaries = executionQueryService.summariesByIds(executionIds);
        List<ToolCallVO> cards = new ArrayList<>(unresolved.size());
        for (ToolCall tool : unresolved) {
            cards.add(toolCallConverter.toVO(tool, gateOf(tool.getExecutionId(), summaries)));
        }
        return cards;
    }

    /**
     * 执行摘要状态 → 展示闸门（与 {@code CardAvailabilityPolicy.ExecutionGate} 同词表）。
     *
     * <p>{@code SUSPENDED→SUSPENDED}、{@code RUNNING/CREATED→ACTIVE}、摘要缺失→{@code UNKNOWN}、
     * 其余→{@code NOT_SUSPENDED}。这是 §8.2 定稿的映射，保证 bootstrap 与提交事件对「能否决策」
     * 给同一判定。</p>
     */
    private static CardAvailabilityPolicy.ExecutionGate gateOf(
            Long executionId, Map<Long, ExecutionQueryService.ExecutionSummary> summaries) {
        ExecutionQueryService.ExecutionSummary summary = executionId == null ? null : summaries.get(executionId);
        if (summary == null || summary.status() == null) {
            return CardAvailabilityPolicy.ExecutionGate.UNKNOWN;
        }
        return switch (summary.status()) {
            case "SUSPENDED" -> CardAvailabilityPolicy.ExecutionGate.SUSPENDED;
            case "RUNNING", "CREATED" -> CardAvailabilityPolicy.ExecutionGate.ACTIVE;
            default -> CardAvailabilityPolicy.ExecutionGate.NOT_SUSPENDED;
        };
    }

    /**
     * 进行中轮次：一次 IN 批量取（ACCEPTED/RUNNING/WAITING），转视图。
     *
     * <p>只补「历史分页取不到的活跃轮次」；已终结轮次由 {@code history.turns} 承载，两者互补。
     * 整批共用一个查询时刻算已历时，避免同批不同行差几毫秒。</p>
     */
    private List<ChatTurnVO> resolveActiveTurns(List<Long> sessionIds) {
        List<ChatTurn> active = chatTurnService.findActiveBySessionIds(sessionIds);
        if (active.isEmpty()) {
            return List.of();
        }
        Instant now = Instant.now();
        return active.stream().map(turn -> chatTurnConverter.toVO(turn, now)).toList();
    }

    /**
     * 本根会话下「进行中或挂起」的执行：一次 IN 批量取（带执行身份），映射成
     * {@link ExecutionStateVO}。
     *
     * <p>只下框架状态名与起止时间，不下 token / 模型（权威在 {@code chat_turn}）。
     * {@code executionId} 是前端判 §8.1 退出路径 2 的依据 —— 必须带上，否则前端只能按
     * 「会话级」近似，无法精确定位哪个接续片段所属的执行已终结。</p>
     */
    private List<ExecutionStateVO> resolveExecutionStates(List<Long> sessionIds) {
        return executionQueryService.activeBySession(sessionIds).stream()
                .map(active -> new ExecutionStateVO(
                        active.executionId() == null ? null : String.valueOf(active.executionId()),
                        active.sessionId() == null ? null : String.valueOf(active.sessionId()),
                        active.status(),
                        active.startedAt(),
                        active.completedAt()))
                .toList();
    }
}
