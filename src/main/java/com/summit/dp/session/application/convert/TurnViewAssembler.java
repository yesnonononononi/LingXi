package com.summit.dp.session.application.convert;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.block.*;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallBlockView;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigInteger;
import java.util.*;

/**
 * 一轮的 Block 装配器：{@code session_message} + {@code chat_turn} + {@code tool_call}
 * → 块列表（**历史与实时共用同一实现**）。
 *
 * <p><b>为什么历史与实时必须共用</b>：两条链路各写一套装配，前端就得写两套对账逻辑 ——
 * 那正是本次要收掉的东西。凡是「这个块长什么样、什么顺序、什么状态」的判断，只能在这里有一份。</p>
 *
 * <p><b>纯计算</b>：本类不持有仓储、不发起查询（与 {@code SessionMessageViewAssembler} 同构）。
 * 工具行的内容以调用方批量装载好的 {@code toolCall} 字典为准，避免 N+1。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class TurnViewAssembler {

    private final ObjectMapper objectMapper;
    private final ToolBlockStatusResolver toolBlockStatusResolver;

    /**
     * 装配一个轮次的块列表。
     *
     * @param turnId     目标轮次 ID
     * @param messages   该会话的消息（本方法只取 {@code turnId} 匹配的行）
     * @param toolCalls  本批消息涉及的 {@code tool_call} 行，按 {@code toolCallId} 建索引
     * @param turnStatus 本轮业务状态（决定终态；{@code null} 视为未知／未完成）
     * @return 按响应身份与响应内位置排序的块列表；无内容返回空列表
     */
    public List<Block> assembleBlocks(Long turnId, List<SessionMessage> messages,
                                      Map<String, ToolCall> toolCalls, ChatTurnStatus turnStatus) {
        if (turnId == null || messages == null || messages.isEmpty()) {
            return List.of();
        }
        // 「是否收尾响应」是本轮所有 AI 行的相对关系：先算出本轮最后一条模型响应的身份。
        String concludingResponseId = resolveConcludingResponseId(turnId, messages);
        boolean executionCompleted = turnStatus == ChatTurnStatus.COMPLETED;
        List<Block> blocks = new ArrayList<>();
        for (SessionMessage message : messages) {
            if (turnId.equals(message.getTurnId()) && message.getType() == SessionMessageType.AI) {
                appendAiBlocks(blocks, message, toolCalls, concludingResponseId, executionCompleted);
            }
        }
        blocks.sort(BlockOrder::compare);
        return blocks;
    }

    /**
     * 求本轮「收尾响应」的身份：本轮所有 AI 行 {@code responseId} 中可解析为纯数字的最大值。
     *
     * <p><b>为什么按数值最大而非行序</b>：响应身份来自框架，是全局单调递增的大整数；
     * 行序受落库时序影响并不可靠。这里与 {@link BlockOrder#compare} 同口径（{@link BigInteger} 比较），
     * 保证「排序的末位」与「判定的收尾」是同一个。</p>
     *
     * <p><b>为什么要区分收尾</b>：根执行可能在「无工具调用的响应」之后因等待子任务而挂起
     * （框架 {@code LoopInterceptor.onBeforeComplete} 返回 {@code suspended}），
     * 挂起响应后面还会继续产出，不是正文。挂起后恢复并完成时，DB 里会有
     * {@code R1(无工具请求, 曾挂起)} 与 {@code R2(无工具请求, 收尾)} 两行，此时轮次已是
     * {@code COMPLETED} —— 只有靠「是否为该轮最后一条模型响应」才能把 {@code R1} 排除。</p>
     *
     * <p>不可解析为纯数字的行<b>跳过</b>：非数字身份的拒绝由 {@link #appendAiBlocks} 现有的
     * {@link ClientException} 负责，本方法不越权抛异常。</p>
     */
    private String resolveConcludingResponseId(Long turnId, List<SessionMessage> messages) {
        String concluding = null;
        BigInteger concludingValue = null;
        for (SessionMessage message : messages) {
            if (!turnId.equals(message.getTurnId()) || message.getType() != SessionMessageType.AI) {
                continue;
            }
            String responseId = message.getResponseId();
            if (responseId == null || !responseId.matches("[0-9]+")) {
                continue;
            }
            BigInteger value = new BigInteger(responseId);
            if (concludingValue == null || value.compareTo(concludingValue) > 0) {
                concludingValue = value;
                concluding = responseId;
            }
        }
        return concluding;
    }

    /**
     * 展开一条 AI 行：思考块 → 正文块 →（按框架请求位置）工具块。
     *
     * <p><b>工具块顺序取自框架的 {@code requestIndex}</b>，不是完成顺序 —— 完成顺序受并发调度
     * 影响，还原不出模型意图。工具结果则从批量装载的 {@code tool_call} 字典取。</p>
     *
     * @param concludingResponseId 本轮收尾响应的身份；{@code null} 表示无从判定（无收尾）
     * @param executionCompleted   本轮是否正常完成（{@code COMPLETED}）
     */
    private void appendAiBlocks(List<Block> blocks, SessionMessage aiRow, Map<String, ToolCall> toolCalls,
                                String concludingResponseId, boolean executionCompleted) {
        AiMessageEntity aiMessage = parse(aiRow.getText());
        String responseId = requireResponseId(aiRow.getResponseId());

        // 该 AI 行是否有工具请求 —— 这既是 isBody 判据之一，也决定工具块是否展开。
        List<ToolCallRequest> requests = aiMessage == null || aiMessage.getToolCalls() == null
                ? List.of() : aiMessage.getToolCalls();

        String thinking = aiMessage == null ? null : aiMessage.getThinking();
        if (thinking != null && !thinking.isBlank()) {
            blocks.add(new ThinkingBlock(ThinkingBlock.identity(responseId), responseId,
                    BlockOrder.thinking(), BlockStatus.COMPLETE, thinking));
        }

        // 正文块：isBody 由「无工具请求 + 本轮收尾 + 轮次完成」三者共同判定（唯一规则见 BodyPlacement）。
        String text = aiMessage == null ? aiRow.getText() : aiMessage.text();
        List<String> imageUrls = aiMessage == null || aiMessage.getImages() == null ? List.of()
                : aiMessage.getImages().stream().map(image -> image.getUrl().toString()).toList();
        if ((text != null && !text.isBlank()) || !imageUrls.isEmpty()) {
            boolean isBody = BodyPlacement.resolve(requests, responseId.equals(concludingResponseId),
                    executionCompleted);
            blocks.add(new TextBlock(TextBlock.identity(responseId), responseId,
                    BlockOrder.text(), BlockStatus.COMPLETE, isBody, text == null ? "" : text, imageUrls));
        }

        for (ToolCallRequest request : requests) {
            if (request == null || request.id() == null || request.id().isBlank()) {
                continue;
            }
            ToolCall toolCall = toolCalls == null ? null : toolCalls.get(request.id());
            blocks.add(buildToolBlock(responseId, BlockOrder.tool(request.requestIndex()), request,
                    ToolFacts.of(toolCall)));
        }
    }

    /**
     * 由框架工具事件的权威事实直接构造工具块（BLOCK_UPSERT 主路径）。
     *
     * <p><b>为什么不需要消息</b>：响应身份、请求位置、工具名与参数都由框架事件给出，
     * 工具状态与结果来自工具行只读投影。原先为了拿到「哪个响应请求了它」要读整轮消息并逐行解析
     * 完整 {@code AiMessageEntity}，现在这条路一次消息查询都不需要。</p>
     *
     * <p>字段映射复用 {@link #buildToolBlock}（唯一来源），不另写一份。</p>
     *
     * @param facts    事件事实；{@code toolCallId} 为空视为无目标，返回空
     * @param toolCall 工具行只读投影（{@code null} 表示尚未落库，按「已开始」造块）
     * @return 该块
     * @throws ClientException 响应身份不可解析（与整轮路径同一条拒绝口径）
     */
    public Optional<Block> buildSingleToolBlock(ToolBlockEventFacts facts, ToolCallBlockView toolCall) {
        if (facts == null || facts.toolCallId() == null || facts.toolCallId().isBlank()) {
            return Optional.empty();
        }
        String responseId = requireResponseId(facts.responseId());
        ToolCallRequest request = new ToolCallRequest(facts.toolCallId(), facts.toolName(),
                facts.requestIndex(), facts.args());
        return Optional.of(buildToolBlock(responseId, BlockOrder.tool(facts.requestIndex()), request,
                ToolFacts.of(toolCall)));
    }

    /**
     * 工具块构造的唯一入口之上的作用点：响应身份必须可解析。
     *
     * <p>整轮路径与事件路径共用这一处校验，保证「同一条数据、同一条拒绝」——
     * 各自写一遍迟早出现「历史报错、增量静默」。</p>
     */
    private static String requireResponseId(String responseId) {
        if (responseId == null || !responseId.matches("[0-9]+")) {
            throw new ClientException("历史模型响应缺少框架身份，请重新开始会话");
        }
        return responseId;
    }

    /**
     * 只构造<b>目标那一个</b>工具块（BLOCK_UPSERT 单块推送用）。
     *
     * <p>不再走「整轮装配 → 过滤」：那等于为了一个块把整轮所有兄弟工具调用的 CLOB 全读一遍。
     * 定位口径与 {@link #assembleBlocks} 完全一致 —— 按消息顺序找第一处
     * {@code AI 行 → 工具请求 id} 匹配，因此结果与「整轮装配后按 blockId 过滤」逐字段相等。</p>
     *
     * <p>工具行缺失（尚未落库的实时窗口）时按「已开始」造块，与整轮路径同一规则。</p>
     *
     * @param turnId     目标轮次
     * @param messages   该轮消息（VO 元数据与请求原文都来自它们）
     * @param toolCallId 目标工具调用 ID
     * @param toolCall   只读投影（可为 {@code null}，表示行还没落库）
     * @return 该块；该轮没有任何 AI 行请求过它时返回空（对应「空则跳过」的推送语义）
     * @throws ClientException 目标 AI 行的响应身份不可解析（与整轮路径同一条拒绝规则）
     */
    public Optional<Block> buildSingleToolBlock(Long turnId, List<SessionMessage> messages,
                                               String toolCallId, ToolCallBlockView toolCall) {
        if (turnId == null || messages == null || toolCallId == null || toolCallId.isBlank()) {
            return Optional.empty();
        }
        for (SessionMessage message : messages) {
            if (message == null || !turnId.equals(message.getTurnId())
                    || message.getType() != SessionMessageType.AI) {
                continue;
            }
            AiMessageEntity aiMessage = parse(message.getText());
            if (aiMessage == null || aiMessage.getToolCalls() == null) {
                continue;
            }
            for (ToolCallRequest request : aiMessage.getToolCalls()) {
                if (request == null || !toolCallId.equals(request.id())) {
                    continue;
                }
                String responseId = requireResponseId(message.getResponseId());
                return Optional.of(buildToolBlock(responseId, BlockOrder.tool(request.requestIndex()),
                        request, ToolFacts.of(toolCall)));
            }
        }
        return Optional.empty();
    }

    /**
     * 构造工具块（<b>块字段映射的唯一来源</b>）。
     *
     * <p>工具块身份来自 {@code toolCallId}，{@code responseId} 用于确定所属模型响应的位置。
     * 状态来自权威工具视图；工具调用行缺失（尚未落库的实时窗口）时按「已开始」展示，
     * 因为此刻它确实已被模型请求、只是还没有结论。</p>
     */
    private ToolBlock buildToolBlock(String responseId, int order, ToolCallRequest request, ToolFacts facts) {
        String toolCallId = request.id();
        if (facts == null) {
            return new ToolBlock(ToolBlock.identity(toolCallId), responseId, order,
                    BlockStatus.TOOL_STARTED, toolCallId, request.name(), request.arguments(),
                    null, null, null, null);
        }
        return new ToolBlock(ToolBlock.identity(toolCallId), responseId, order,
                toolBlockStatusResolver.resolve(facts.status(), facts.rawOutput()), toolCallId,
                facts.toolName() == null ? request.name() : facts.toolName(),
                request.arguments(), facts.rawOutput(), null, null, facts.version());
    }

    /**
     * 工具块需要的权威事实：整轮路径来自领域实体、单块路径来自只读投影。
     *
     * <p>两条路径共用 {@link #buildToolBlock} 的同一份字段映射，避免「历史一套、增量一套」。</p>
     */
    private record ToolFacts(String toolName, ToolCallStatus status, String rawOutput, Long version) {

        /** 领域实体 → 事实；{@code null} 表示行尚未落库。 */
        static ToolFacts of(ToolCall toolCall) {
            if (toolCall == null) {
                return null;
            }
            return new ToolFacts(toolCall.getToolName(), toolCall.getStatus(),
                    toolCall.getRawOutput(), toolCall.getVersion());
        }

        /** 只读投影 → 事实；{@code null} 表示行尚未落库。 */
        static ToolFacts of(ToolCallBlockView toolCall) {
            if (toolCall == null) {
                return null;
            }
            return new ToolFacts(toolCall.toolName(), toolCall.status(),
                    toolCall.rawOutput(), toolCall.version());
        }
    }

    /**
     * 取本轮用户提问文本。
     *
     * <p>提问是会话级的「这一轮问了什么」，来自该轮最早的 USER 行；缺省返回 {@code null}。</p>
     */
    public String resolveUserMessage(Long turnId, List<SessionMessage> messages) {
        SessionMessage earliest = resolveUserRecord(turnId, messages);
        if (earliest == null) return null;
        UserMessageEntity user = parseUser(earliest.getText());
        return user == null ? earliest.getText() : user.text();
    }

    public List<String> resolveUserImageUrls(Long turnId, List<SessionMessage> messages) {
        SessionMessage earliest = resolveUserRecord(turnId, messages);
        return earliest == null ? List.of() : UserImageViewAssembler.resolveImageUrls(parseUser(earliest.getText()));
    }

    public List<ResumeSupplementVO> resolveResumeSupplements(Long turnId, List<SessionMessage> messages) {
        return messages.stream().filter(message -> turnId.equals(message.getTurnId())
                        && message.getType() == SessionMessageType.USER && message.getResumeRequestId() != null)
                .sorted(Comparator.comparing(SessionMessage::getId))
                .map(message -> {
                    UserMessageEntity user = parseUser(message.getText());
                    return new ResumeSupplementVO(message.getId(), user == null ? message.getText() : user.text(),
                            message.getCreateTime());
                }).toList();
    }

    private SessionMessage resolveUserRecord(Long turnId, List<SessionMessage> messages) {
        if (turnId == null || messages == null) {
            return null;
        }
        SessionMessage earliest = null;
        for (SessionMessage message : messages) {
            if (!turnId.equals(message.getTurnId()) || message.getType() != SessionMessageType.USER) {
                continue;
            }
            if (earliest == null || (message.getId() != null && earliest.getId() != null
                    && message.getId() < earliest.getId())) {
                earliest = message;
            }
        }
        return earliest;
    }

    /** 会话级上下文用量快照 → 指标；未采集返回 {@code null}（不显示 0）。 */
    public static ContextUsageMetric resolveMetric(Session session) {
        if (session == null || session.getContextTokenCount() == null) {
            return null;
        }
        int maxTokens = session.getContextMaxTokens() == null ? 0 : session.getContextMaxTokens();
        return ContextUsageMetric.of(session.getContextTokenCount().intValue(), maxTokens);
    }

    /** 轮次状态字符串；缺失返回 {@code null}（未知，不冒充）。 */
    public static String resolveTurnStatus(ChatTurn turn) {
        return turn == null || turn.getStatus() == null ? null : turn.getStatus().name();
    }

    /**
     * 收集本轮装配需要的工具调用 id 集合（供调用方一次 {@code IN} 装载）。
     *
     * <p>范围 = 本轮 AI 行 {@code toolCalls} 里的 id **并上** TOOL 行的 {@code content}。
     * 取并集而非只取 TOOL 行：AI 行的请求可能尚未产生 TOOL 行（实时窗口），
     * 但只要模型请求过，就要能装配出工具块。</p>
     */
    public Set<String> collectToolCallIds(Long turnId, List<SessionMessage> messages) {
        Set<String> ids = new LinkedHashSet<>();
        if (turnId == null || messages == null) {
            return ids;
        }
        for (SessionMessage message : messages) {
            if (message != null && turnId.equals(message.getTurnId())) {
                collectToolCallIds(message, ids);
            }
        }
        return ids;
    }

    /**
     * 页级并集：<b>不按轮次过滤</b>（历史分页一次装载用）。
     *
     * <p>与 {@link #collectToolCallIds(Long, List)} 唯一的差别就是不过滤 {@code turnId}：
     * {@code turn_id} 为 null 的孤儿 TOOL 行也要能挂上卡片，按轮次过滤会把它们漏掉。</p>
     */
    public Set<String> collectToolCallIds(List<SessionMessage> messages) {
        Set<String> ids = new LinkedHashSet<>();
        if (messages == null) {
            return ids;
        }
        for (SessionMessage message : messages) {
            collectToolCallIds(message, ids);
        }
        return ids;
    }

    /** 单行贡献的 id：TOOL 行的 content 即 call_id；AI 行的 toolCalls 即模型请求。 */
    private void collectToolCallIds(SessionMessage message, Set<String> ids) {
        if (message == null) {
            return;
        }
        if (message.getType() == SessionMessageType.TOOL) {
            // TOOL 行的 content 即 call_id（设计 §7.3）。
            if (message.getText() != null && !message.getText().isBlank()) {
                ids.add(message.getText().trim());
            }
            return;
        }
        if (message.getType() != SessionMessageType.AI) {
            return;
        }
        AiMessageEntity aiMessage = parse(message.getText());
        if (aiMessage == null || aiMessage.getToolCalls() == null) {
            return;
        }
        for (ToolCallRequest request : aiMessage.getToolCalls()) {
            if (request != null && request.id() != null && !request.id().isBlank()) {
                ids.add(request.id());
            }
        }
    }

    /** 解析 AI 行载荷；失败降级为空（正文回退为原始文本）。 */
    private AiMessageEntity parse(String content) {
        if (content == null || content.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readValue(content, AiMessageEntity.class);
        } catch (Exception e) {
            log.warn("AI 行载荷解析失败，按不可用处理: {}", e.getMessage());
            return null;
        }
    }

    private UserMessageEntity parseUser(String content) {
        if (content == null || content.isBlank()) {
            return null;
        }
        try {
            return objectMapper.readValue(content, UserMessageEntity.class);
        } catch (Exception e) {
            return null;
        }
    }
}
