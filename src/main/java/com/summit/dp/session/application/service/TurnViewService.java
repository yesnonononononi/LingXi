package com.summit.dp.session.application.service;

import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallBlockView;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
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
        Map<String, ToolCall> toolCalls = loadToolCallsForTurn(messages, turn.getId());
        return Optional.of(buildView(session, turn, viewVersion, messages, toolCalls));
    }

    /**
     * 单块装配：只构造目标工具块，不装载兄弟工具的全量 CLOB。
     *
     * <p>BLOCK_UPSERT 原先走整轮装配再过滤 —— 一次工具收尾就要把整轮所有工具调用的
     * content/raw_input/raw_output/meta_data 读一遍。这里消息仍按本轮取（VO 的状态、提问、
     * 用量等元数据都来自该轮消息与 session），工具调用只取目标那一个，
     * 且用只读投影省掉三个不需要的 CLOB 列；块本身由
     * {@link TurnViewAssembler#buildSingleToolBlock} 用与整轮完全相同的字段映射构造。</p>
     *
     * <p>返回的视图<b>只用于推送</b>，其中的工具事实来自只读投影，绝不能拿去 {@code updateById}。</p>
     *
     * @param toolCallId 目标工具调用；块身份规则是 {@code tool:<toolCallId>}
     * @return 只含该块的视图；该块此刻不存在时返回空（对应「空则跳过」的推送语义）
     */
    public Optional<TurnViewVO> assembleToolBlockView(Session session, ChatTurn turn, long viewVersion,
                                                      String toolCallId) {
        if (turn == null || turn.getId() == null || turn.getSessionId() == null
                || toolCallId == null || toolCallId.isBlank()) {
            return Optional.empty();
        }
        // 消息仍要装载：VO 的状态 / 提问 / 图片 / 补录 / 用量都来自该轮消息。
        List<SessionMessage> messages = messageRepository.findByTurnIds(turn.getSessionId(), List.of(turn.getId()));
        // 目标工具行只查一次，且是只读投影（不读 content / raw_input / meta_data）。
        ToolCallBlockView toolCall = toolCallRepository.findForBlockUpsert(toolCallId).orElse(null);
        Optional<Block> block = turnViewAssembler.buildSingleToolBlock(turn.getId(), messages, toolCallId, toolCall);
        return block.map(single -> buildViewFromBlocks(session, turn, viewVersion, messages, List.of(single)));
    }

    /**
     * 批量装配一页内多个轮次的展示视图（历史分页用）。
     *
     * <p><b>复用当页已查出的消息</b>：历史按轮次分页，{@code pageMessages} 就是这一页所有轮次的
     * 全部消息（外加 {@code turn_id} 为 null 的孤儿行，分组时自然忽略），因此按 {@code turnId}
     * 分组的结果与该轮的 {@code findByTurnIds} 完全一致。原先逐轮调用 {@link #assembleTurnView}
     * 是 2N 次查询，改造后是 2 次。</p>
     *
     * <p><b>工具调用跨轮一次装载</b>：本页所有轮次的 {@code toolCallId} 取并集后一次 {@code IN}；
     * 分轮各查会让长会话的每一页都退回 N+1。</p>
     *
     * @param session      会话（提供用量快照；{@code null} 时 metric 为 null）
     * @param turns        本页轮次
     * @param pageMessages 本页消息（可含其它轮次与孤儿行，本方法只取匹配轮次的行）
     * @return {@code turnId} 的字符串形态 → 该轮视图；顺序与 {@code turns} 的迭代顺序一致
     */
    public Map<String, TurnViewVO> assembleTurnViews(Session session, Collection<ChatTurn> turns,
                                                     List<SessionMessage> pageMessages) {
        if (turns == null || turns.isEmpty()) {
            // 无轮次就不必装载工具调用：省一次查询，也让「空页零查询」这条不变量成立。
            return new LinkedHashMap<>();
        }
        return assembleTurnViews(session, turns, pageMessages, loadToolCalls(pageMessages));
    }

    /**
     * 批量装配一页内多个轮次，<b>工具调用字典由调用方提供</b>（已装载的那一批）。
     *
     * <p>历史消息读路径上，同一批权威 {@code ToolCall} 既用于消息 VO 的挂载、又用于块装配。
     * 两个入口各查一次等于同一批 CLOB 读两遍，所以字典只装载一次、由调用方传进来。</p>
     *
     * @param toolCalls 已装载的工具调用字典（可为空字典，表示本页没有工具调用）
     * @return {@code turnId} 的字符串形态 → 该轮视图；顺序与 {@code turns} 的迭代顺序一致
     */
    public Map<String, TurnViewVO> assembleTurnViews(Session session, Collection<ChatTurn> turns,
                                                     List<SessionMessage> pageMessages,
                                                     Map<String, ToolCall> toolCalls) {
        Map<String, TurnViewVO> views = new LinkedHashMap<>();
        if (turns == null || turns.isEmpty()) {
            return views;
        }
        Map<Long, List<SessionMessage>> messagesByTurn = groupByTurnId(pageMessages);
        for (ChatTurn turn : turns) {
            if (turn == null || turn.getId() == null || turn.getSessionId() == null) {
                continue;
            }
            long viewVersion = turn.getVersion() == null ? 0L : turn.getVersion();
            views.put(String.valueOf(turn.getId()), buildView(session, turn, viewVersion,
                    messagesByTurn.getOrDefault(turn.getId(), List.of()), toolCalls));
        }
        return views;
    }

    /**
     * 单轮视图的构造（VO 字段的唯一来源）。
     *
     * <p>历史分页、实时快照、单块增量三条路径共用它：任何一条另写一遍字段映射，
     * 都会让「同一条消息在两个入口长得不一样」重新出现。</p>
     */
    private TurnViewVO buildView(Session session, ChatTurn turn, long viewVersion,
                                 List<SessionMessage> messages, Map<String, ToolCall> toolCalls) {
        List<Block> blocks = turnViewAssembler.assembleBlocks(turn.getId(), messages, toolCalls,
                turn.getStatus());
        return buildViewFromBlocks(session, turn, viewVersion, messages, blocks);
    }

    /**
     * 「元数据 + 块列表」的组装（VO 字段的唯一来源）。
     *
     * <p>整轮装配传入 {@code assembleBlocks} 的结果，单块推送传入只含一个块的列表 ——
     * 两条入口的元数据映射完全相同，块的身份 / 顺序 / 状态也都来自 {@link TurnViewAssembler}。</p>
     */
    private TurnViewVO buildViewFromBlocks(Session session, ChatTurn turn, long viewVersion,
                                           List<SessionMessage> messages, List<Block> blocks) {
        Long turnId = turn.getId();
        return new TurnViewVO(
                turn.getSessionId(),
                turnId,
                TurnViewAssembler.resolveTurnStatus(turn),
                viewVersion,
                turnViewAssembler.resolveUserMessage(turnId, messages),
                turnViewAssembler.resolveUserImageUrls(turnId, messages),
                blocks,
                TurnViewAssembler.resolveMetric(session),
                messages.stream().filter(message -> turnId.equals(message.getTurnId())
                        && message.getType() == SessionMessageType.USER)
                        .map(SessionMessage::getId).findFirst().orElse(null),
                turnViewAssembler.resolveResumeSupplements(turnId, messages),
                turn.getParentTurnId());
    }

    /** 按 {@code turnId} 分组当页消息；孤儿行（{@code turnId} 为 null）不参与任何一轮。 */
    private static Map<Long, List<SessionMessage>> groupByTurnId(List<SessionMessage> pageMessages) {
        Map<Long, List<SessionMessage>> grouped = new LinkedHashMap<>();
        if (pageMessages == null) {
            return grouped;
        }
        for (SessionMessage message : pageMessages) {
            if (message == null || message.getTurnId() == null) {
                continue;
            }
            grouped.computeIfAbsent(message.getTurnId(), key -> new ArrayList<>()).add(message);
        }
        // 与 findByTurnIds 的「按主键升序」对齐：VO 的 userMessageId 取首个 USER 行，顺序变了就取错行。
        Comparator<SessionMessage> byId = Comparator.comparing(SessionMessage::getId,
                Comparator.nullsLast(Comparator.naturalOrder()));
        grouped.values().forEach(rows -> rows.sort(byId));
        return grouped;
    }

    /**
     * 页级装载：把当页所有消息涉及的 {@code toolCallId} 取并集后<b>一次</b> {@code IN} 查回。
     *
     * <p>历史消息读路径只发这一次 {@code tool_call} 查询 —— 结果同时供消息 VO 挂载与块装配使用。
     * 并集里既包含 TOOL 行（{@code content}=call_id，含 {@code turn_id} 为 null 的孤儿行），
     * 也包含 AI 行的模型请求（工具尚未出结果、甚至尚未落库时也要能装出块）。</p>
     *
     * @param pageMessages 当页消息（可为 {@code null}）
     * @return {@code toolCallId} → 权威工具调用；无 id 时返回空字典（不发查询）
     */
    public Map<String, ToolCall> loadToolCalls(List<SessionMessage> pageMessages) {
        return toToolCallDictionary(turnViewAssembler.collectToolCallIds(pageMessages));
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
    private Map<String, ToolCall> loadToolCallsForTurn(List<SessionMessage> messages, Long turnId) {
        return toToolCallDictionary(turnViewAssembler.collectToolCallIds(turnId, messages));
    }

    /** 已收集好的 id 集合 → 字典；空集合不发查询。 */
    private Map<String, ToolCall> toToolCallDictionary(Set<String> ids) {
        if (ids.isEmpty()) {
            return Map.of();
        }
        return toolCallRepository.listByIds(ids).stream()
                .collect(Collectors.toMap(ToolCall::getId, toolCall -> toolCall, (first, second) -> first));
    }
}
