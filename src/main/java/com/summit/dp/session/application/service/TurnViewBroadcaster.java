package com.summit.dp.session.application.service;

import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.BlockEventType;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Optional;

/**
 * 块视图的**推送编排**：实时链路把「某一轮现在长什么样」推给订阅了其根会话的流。
 *
 * <p><b>与历史查询共用同一装配口径</b>：本类只做编排（解析路由 → 调
 * {@link TurnViewService} 装配 → 交给 {@link SseEventPublisher} 投递），
 * 块的身份 / 顺序 / 状态全部来自 {@link TurnViewService}，与
 * {@code SessionServiceImpl#messages} 的历史路径是同一份实现 —— 这正是本次改造要收掉
 * 「历史一套、实时一套」的地方。</p>
 *
 * <p><b>为什么本类不自己递增 viewVersion</b>：版本号是「该轮展示的更新批次号」，
 * 由**轮次自身状态变化**驱动，而不是推送次数。这里用 {@code chat_turn.version} 的快照
 * 作为版本 —— 轮次每落库一次版本自增一次，天然与「这一轮被改变了几次」对齐。
 * 前端拿到更小的版本号即丢弃（乱序到达的旧帧）。</p>
 *
 * <p><b>归属与路由严格分开</b>：块内容的归属是 {@code TurnViewVO.sessionId}
 * （子会话就是子会话自身）；推送用的 {@code rootSessionId} 只作传输路由，不进入 VO。
 * 两者混用会因子会话、以及根会话「哨兵 0」而投错桶。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TurnViewBroadcaster {

    private final TurnViewService turnViewService;
    private final ChatTurnRepository chatTurnRepository;
    private final SessionRepository sessionRepository;
    private final SseEventPublisher sseEventPublisher;
    private final ExecutionIdentity executionIdentity;

    /**
     * 按轮次推送一帧业务事件。
     *
     * <p>路由解析失败一律静默跳过（记一条 debug）：推送是**旁路观测**动作，
     * 拿不到归属只说明实体尚未落库或已被清理，不该把「一次模型调用」顶成 500。</p>
     *
     * @param turnId       目标轮次
     * @param eventName    {@link BlockEventType} 中的事件名（快照 / 增量）
     * @param blockIdFilter 只保留该 blockId 的块（{@code BLOCK_UPSERT} 用）；
     *                      {@code null} 表示整轮（{@code TURN_SNAPSHOT} 用）
     */
    public void broadcastTurn(Long turnId, String eventName, String blockIdFilter) {
        if (turnId == null) {
            return;
        }
        ChatTurn turn = chatTurnRepository.findById(turnId).orElse(null);
        if (turn == null || turn.getSessionId() == null) {
            log.debug("推送块视图跳过：轮次或归属缺失: turnId={}", turnId);
            return;
        }
        Long rootSessionId = executionIdentity.resolveRootSessionIdOrNull(turn.getSessionId());
        if (rootSessionId == null) {
            log.debug("推送块视图跳过：根会话无法解析: sessionId={}", turn.getSessionId());
            return;
        }
        Session session = sessionRepository.findById(turn.getSessionId()).orElse(null);
        long viewVersion = turn.getVersion() == null ? 0L : turn.getVersion();
        Optional<TurnViewVO> view = turnViewService.assembleTurnView(session, turn, viewVersion);
        if (view.isEmpty()) {
            return;
        }
        TurnViewVO payloadView = filterBlocks(view.get(), blockIdFilter);
        if (blockIdFilter != null && payloadView.blocks().isEmpty()) {
            // 只有「按 blockId 过滤的增量」才允许空则跳过：过滤后为空说明那个块此刻还不存在
            // （尚未落库的实时窗口），推一帧空块会被前端读成「该块被清空了」。
            // 整轮快照（blockIdFilter == null）绝不能走这个短路：accepted/waiting 这类尚未产出
            // AI 块的轮次块列表本就为空，跳过会让它的 status 永远推不出去。
            return;
        }
        sseEventPublisher.publishBusiness(rootSessionId, eventName,
                new BlockEventType.BlockEventPayload(turn.getSessionId(), turnId, viewVersion, payloadView));
    }

    /**
     * 按 blockId 过滤块列表；{@code blockIdFilter} 为 {@code null} 时原样返回（整轮）。
     *
     * <p>保留轮次的其它字段（状态 / 用量 / 提问），只有 {@code blocks} 被收窄 ——
     * 增量与快照共用同一 {@code TurnViewVO} 形状，前端只需一套 upsert 逻辑。</p>
     */
    private static TurnViewVO filterBlocks(TurnViewVO view, String blockIdFilter) {
        if (blockIdFilter == null) {
            return view;
        }
        List<Block> filtered = view.blocks().stream()
                .filter(block -> blockIdFilter.equals(block.getBlockId()))
                .toList();
        return new TurnViewVO(view.sessionId(), view.turnId(), view.status(), view.viewVersion(),
                view.userMessage(), view.userImageUrls(), filtered, view.metric());
    }

    /**
     * 按执行推送整轮快照：执行上的事件只带 executionId，需要先反查业务轮次。
     *
     * <p>这是实时链路的主要入口 —— 框架生命周期的钩子只给 {@code executionId}
     * （见 {@code eventMetaData}），业务轮次靠 {@code chat_turn.execution_id} 反查。</p>
     *
     * @param executionId 框架执行 ID；解析不出轮次时静默跳过
     */
    public void broadcastSnapshotForExecution(String executionId) {
        Long numericExecutionId = ExecutionIdentity.numericOrNull(executionId);
        if (numericExecutionId == null) {
            return;
        }
        chatTurnRepository.findByExecutionId(numericExecutionId)
                .map(ChatTurn::getId)
                .ifPresent(turnId -> broadcastTurn(turnId, BlockEventType.TURN_SNAPSHOT, null));
    }

    /** 整轮快照：块列表完整下发。 */
    public void broadcastSnapshot(Long turnId) {
        broadcastTurn(turnId, BlockEventType.TURN_SNAPSHOT, null);
    }

    /**
     * 单块增量：只下发指定 blockId 的那一个块。
     *
     * @param toolCallId 变化的工具块身份；工具块的 blockId 规则是 {@code tool:<toolCallId>}
     */
    public void broadcastBlockUpsert(Long turnId, String toolCallId) {
        if (toolCallId == null || toolCallId.isBlank()) {
            return;
        }
        broadcastTurn(turnId, BlockEventType.BLOCK_UPSERT, ToolBlock.identity(toolCallId));
    }
}
