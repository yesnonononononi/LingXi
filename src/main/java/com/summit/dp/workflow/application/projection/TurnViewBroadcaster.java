package com.summit.dp.workflow.application.projection;

import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.application.convert.ToolBlockEventFacts;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.BlockEventType;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
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
    private final ExecutionLocator executionLocator;

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
        BroadcastTarget target = resolveTarget(turnId);
        if (target == null) {
            return;
        }
        Optional<TurnViewVO> view = turnViewService.assembleTurnView(target.session(), target.turn(), target.viewVersion());
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
        publish(target, eventName, payloadView);
    }

    /**
     * 解析推送目标（轮次、会话、路由用的根会话、展示版本号）。
     *
     * <p>解析失败一律静默跳过（记一条 debug）：推送是**旁路观测**动作，拿不到归属只说明实体
     * 尚未落库或已被清理，不该把「一次模型调用」顶成 500。</p>
     *
     * <p><b>这一步只在事件不带权威归属时使用</b>（旧检查点构造的事件没有 {@code turnId} /
     * {@code rootSessionId} 两个键）。它有三次查库：轮次行、会话行，以及「会话 → 根会话」的解析。
     * 事件带齐归属时走 {@link #resolveTarget(TurnBroadcastIdentity)}，只需要读轮次行与会话行。</p>
     */
    private BroadcastTarget resolveTarget(Long turnId) {
        if (turnId == null) {
            return null;
        }
        ChatTurn turn = chatTurnRepository.findById(turnId).orElse(null);
        if (turn == null || turn.getSessionId() == null) {
            log.debug("推送块视图跳过：轮次或归属缺失: turnId={}", turnId);
            return null;
        }
        Long rootSessionId = executionLocator.resolveRootSessionIdOrNull(turn.getSessionId());
        if (rootSessionId == null) {
            log.debug("推送块视图跳过：根会话无法解析: sessionId={}", turn.getSessionId());
            return null;
        }
        Session session = sessionRepository.findById(turn.getSessionId()).orElse(null);
        long viewVersion = turn.getVersion() == null ? 0L : turn.getVersion();
        return new BroadcastTarget(turn, session, rootSessionId, viewVersion);
    }

    private void publish(BroadcastTarget target, String eventName, TurnViewVO view) {
        sseEventPublisher.publishBusiness(target.rootSessionId(), eventName,
                new BlockEventType.BlockEventPayload(target.turn().getSessionId(), target.turn().getId(),
                        target.viewVersion(), view));
    }

    /** 一次推送的路由与版本号；块内容的归属仍是 {@code TurnViewVO.sessionId}（轮次自身）。 */
    private record BroadcastTarget(ChatTurn turn, Session session, Long rootSessionId, long viewVersion) {
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
                view.userMessage(), view.userImageUrls(), filtered, view.metric(), view.userMessageId(), view.resumeSupplements(),
                view.parentTurnId(), view.fileChanges());
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
     * 单块增量（事件事实版，BLOCK_UPSERT 主路径）：直接拿框架事件里的权威身份与参数组装。
     *
     * <p><b>为什么不再传 toolCallId 让服务层反查</b>：反查要读整轮消息并逐行解析 AI 行 JSON，
     * 只为回答「哪个响应请求了它」。事件已经带 {@code responseId} / {@code requestIndex} /
     * {@code toolName} / {@code args}，这条路只发一条 USER 行窄查询 + 一条工具行投影。</p>
     *
     * <p><b>为什么把归属当入参传进来</b>：事件元数据里已带着 {@code turnId} / {@code sessionId} /
     * {@code rootSessionId}，调用方解析一次就够。若不传，监听器要先按执行 ID 反查轮次、
     * 本类再按轮次查一遍会话并再解析一次根会话 —— 同一条事实被解析三遍，其中两遍纯属重复。</p>
     *
     * @param identity 事件携带的权威归属；三键必须齐备
     * @param facts    事件权威事实；{@code toolCallId} 为空时静默跳过
     */
    public void broadcastBlockUpsert(TurnBroadcastIdentity identity, ToolBlockEventFacts facts) {
        if (facts == null || facts.toolCallId() == null || facts.toolCallId().isBlank()) {
            return;
        }
        BroadcastTarget target = resolveTarget(identity);
        if (target == null) {
            return;
        }
        Optional<TurnViewVO> view = turnViewService.assembleToolBlockView(
                target.session(), target.turn(), target.viewVersion(), facts);
        if (view.isEmpty()) {
            // 该块此刻还不存在（尚未落库的实时窗口）：推空块会被前端读成「该块被清空了」。
            return;
        }
        publish(target, BlockEventType.BLOCK_UPSERT, view.get());
    }

    /**
     * 单块增量（回退口径）：只有事件不带权威归属时才走这里。
     *
     * <p><b>保留它是为了旧检查点</b>：重启前落盘的执行元数据里没有 {@code turnId} /
     * {@code rootSessionId}，这些执行仍会把工具事件报上来。这条路与改造前完全一致 ——
     * 按轮次查会话、再解析根会话；它的成本比主路径多两次查库，但只在旧数据上出现，
     * 且下一轮执行构造出的元数据一定带全键，回退会自然消失。</p>
     *
     * @param turnId 目标轮次；{@code null} 时静默跳过
     * @param facts  事件权威事实；{@code toolCallId} 为空时静默跳过
     */
    public void broadcastBlockUpsert(Long turnId, ToolBlockEventFacts facts) {
        if (facts == null || facts.toolCallId() == null || facts.toolCallId().isBlank()) {
            return;
        }
        BroadcastTarget target = resolveTarget(turnId);
        if (target == null) {
            return;
        }
        Optional<TurnViewVO> view = turnViewService.assembleToolBlockView(
                target.session(), target.turn(), target.viewVersion(), facts);
        if (view.isEmpty()) {
            return;
        }
        publish(target, BlockEventType.BLOCK_UPSERT, view.get());
    }

    /**
     * 按事件自带的权威归属解析推送目标：<b>只查两条窄数据</b>，不再解析根会话。
     *
     * <p>仍然必须查库的两项，都是事件里没有、也无法从事件推出来的东西：</p>
     * <ol>
     *   <li><b>轮次行</b>（{@code chat_turn} 主键读）：展示版本号 {@code version}、
     *       轮次状态、{@code parentTurnId} 都在这一行上。版本号是「该轮被改变了几次」的
     *       落库结果，事件里没有、也不能靠推送次数累加（那是另一份状态）。</li>
     *   <li><b>会话行</b>（{@code session} 主键读）：上下文用量快照是 VO 的 {@code metric}，
     *       由会话上的持久化值决定；事件里的瞬时 {@code usage} 与落库值口径不同，不能冒充。</li>
     * </ol>
     *
     * <p><b>归属冲突一律丢弃</b>：元数据与轮次行声称的会话不一致时直接返回 {@code null}，
     * 不拿任一方凑合发出去 —— 「拿不到归属就丢弃」的语义在这里同样成立。</p>
     */
    private BroadcastTarget resolveTarget(TurnBroadcastIdentity identity) {
        if (identity == null || identity.turnId() == null) {
            return null;
        }
        ChatTurn turn = chatTurnRepository.findById(identity.turnId()).orElse(null);
        if (turn == null) {
            log.debug("推送块视图跳过：元数据指向的轮次不存在: turnId={}", identity.turnId());
            return null;
        }
        if (!identity.matchesTurnSession(turn.getSessionId())) {
            log.warn("丢弃归属不一致的推送：metadata.sessionId={}, turn.sessionId={}, turnId={}",
                    identity.sessionId(), turn.getSessionId(), identity.turnId());
            return null;
        }
        Session session = sessionRepository.findById(identity.sessionId()).orElse(null);
        long viewVersion = turn.getVersion() == null ? 0L : turn.getVersion();
        return new BroadcastTarget(turn, session, identity.rootSessionId(), viewVersion);
    }
}
