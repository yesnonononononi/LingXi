package com.summit.dp.session.application.service;

import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 一轮展示视图的读路径编排：装载（消息 + 轮次 + 工具调用）→ 装配（{@link TurnViewAssembler}）。
 *
 * <p><b>为什么编排与装配分开</b>：装配是纯函数（可独立单测），IO 编排在这里集中 ——
 * 否则装配器要么自己查库（N+1、不可复用），要么在多个调用点各写一遍装载顺序（漏装载 = 块静默丢失）。</p>
 *
 * <p><b>一次 {@code IN} 装载工具调用</b>：先从本轮 AI 行的工具请求收集去重 {@code toolCallId} 集合，
 * 再批量查回建字典。不逐行查。</p>
 *
 * <p><b>装载范围只限本轮</b>：消息按 {@code turn_id IN (本轮)} 取，不读整个会话 ——
 * 实时链路每个工具收尾都装配一次，读全会话的代价会随会话长度线性增长。</p>
 *
 * <p><b>版本号</b>：{@code viewVersion} 是「该轮展示的更新批次号」，由调用方决定（历史查询用
 * 轮次自身的 {@code version}；实时装配由发布侧递增并作废旧请求）。本类只透传。</p>
 */
@Service
@RequiredArgsConstructor
public class TurnViewService {

    private final MessageRepository messageRepository;
    private final ChatTurnRepository chatTurnRepository;
    private final ToolCallRepository toolCallRepository;
    private final TurnViewAssembler turnViewAssembler;

    /**
     * 装配一次会话中某一轮的展示视图。
     *
     * @param session       会话（提供用量快照；{@code null} 时 metric 为 null）
     * @param turn          业务轮次；{@code null} 时状态为 null（未知，不冒充）
     * @param viewVersion   对外展示版本号
     * @return 该轮视图；轮次不存在返回 {@link Optional#empty()}
     */
    public Optional<TurnViewVO> assembleTurnView(Session session, ChatTurn turn, long viewVersion) {
        if (turn == null || turn.getId() == null) {
            return Optional.empty();
        }
        Long sessionId = turn.getSessionId();
        if (sessionId == null) {
            return Optional.empty();
        }
        // 只装载本轮的消息：装配器本就只取 turnId 匹配的行，此处把过滤前置到 SQL。
        // 曾用 findBySessionId（无 LIMIT）读回整个会话再在内存里过滤 —— 代价随会话总长线性增长，
        // 而实时链路每个工具收尾都要装配一次，长会话下会成为主成本。
        List<SessionMessage> messages = messageRepository.findByTurnIds(sessionId, List.of(turn.getId()));
        Map<String, ToolCall> toolCalls = loadToolCalls(messages, turn.getId());
        List<Block> blocks = turnViewAssembler.assembleBlocks(turn.getId(), messages, toolCalls);

        return Optional.of(new TurnViewVO(
                sessionId,
                turn.getId(),
                TurnViewAssembler.resolveTurnStatus(turn),
                viewVersion,
                turnViewAssembler.resolveUserMessage(turn.getId(), messages),
                turnViewAssembler.resolveUserImageUrls(turn.getId(), messages),
                blocks,
                TurnViewAssembler.resolveMetric(session)
        ));
    }

    /**
     * 按轮次 ID 直接装配（内部使用；会话由调用方持有）。
     *
     * <p>{@code sessionId} 取自轮次自身 —— 它才是块的**真实归属**，不复用任何路由用的根会话 id。</p>
     */
    public Optional<TurnViewVO> assembleTurnView(Long turnId, long viewVersion) {
        if (turnId == null) {
            return Optional.empty();
        }
        ChatTurn turn = chatTurnRepository.findById(turnId).orElse(null);
        if (turn == null) {
            return Optional.empty();
        }
        return assembleTurnView(null, turn, viewVersion);
    }

    /**
     * 批量装载本轮涉及的工具调用：一次 {@code IN} 查询。
     *
     * <p>收集范围由 {@link TurnViewAssembler#collectToolCallIds} 给出 —— 它是「本轮 AI 行请求的 id」
     * 与「TOOL 行引用的 id」的并集，正好覆盖「工具块按模型请求顺序展开」的需求
     * （含尚未出结果、甚至尚未落库的调用）。</p>
     */
    private Map<String, ToolCall> loadToolCalls(List<SessionMessage> messages, Long turnId) {
        Set<String> ids = turnViewAssembler.collectToolCallIds(turnId, messages);
        if (ids.isEmpty()) {
            return Map.of();
        }
        return toolCallRepository.listByIds(ids).stream()
                .collect(Collectors.toMap(ToolCall::getId, toolCall -> toolCall, (first, second) -> first));
    }
}
