package com.summit.dp.session.application.convert;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.BlockOrder;
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.Placement;
import com.summit.dp.shared.vo.block.TextBlock;
import com.summit.dp.shared.vo.block.ThinkingBlock;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.turn.domain.model.ChatTurn;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

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
     * @param turnId    目标轮次 ID
     * @param messages  该会话的消息（本方法只取 {@code turnId} 匹配的行）
     * @param toolCalls 本批消息涉及的 {@code tool_call} 行，按 {@code toolCallId} 建索引
     * @return 按响应身份与响应内位置排序的块列表；无内容返回空列表
     */
    public List<Block> assembleBlocks(Long turnId, List<SessionMessage> messages, Map<String, ToolCall> toolCalls) {
        if (turnId == null || messages == null || messages.isEmpty()) {
            return List.of();
        }
        // 旧 UUID 缺少递增身份，保留历史序号与行主键口径；新响应在展开后统一按框架身份排。
        List<SessionMessage> turnMessages = new ArrayList<>();
        for (SessionMessage message : messages) {
            if (turnId.equals(message.getTurnId())) {
                turnMessages.add(message);
            }
        }
        turnMessages.sort(Comparator
                .comparing(SessionMessage::getResponseOrder, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparing(SessionMessage::getId));

        List<Block> blocks = new ArrayList<>();
        for (SessionMessage message : turnMessages) {
            if (message.getType() != SessionMessageType.AI) {
                continue;   // USER 行承载提问、TOOL 行由所属 AI 行的 toolCalls 展开，均不单独成块
            }
            appendAiBlocks(blocks, message, toolCalls);
        }
        blocks.sort(BlockOrder::compare);
        return blocks;
    }

    /**
     * 展开一条 AI 行：思考块 → 正文块 →（按其工具请求列表顺序）工具块。
     *
     * <p><b>工具块顺序取自 {@code toolCalls} 列表下标</b>，不是完成顺序 —— 完成顺序受并发调度
     * 影响，还原不出模型意图。工具结果则从批量装载的 {@code tool_call} 字典取。</p>
     */
    private void appendAiBlocks(List<Block> blocks, SessionMessage aiRow, Map<String, ToolCall> toolCalls) {
        AiMessageEntity aiMessage = parse(aiRow.getText());
        Integer responseOrder = aiRow.getResponseOrder();
        String responseId = aiRow.getResponseId();

        // 该 AI 行是否有工具请求 —— 这既是 placement 判据，也决定工具块是否展开。
        List<ToolCallRequest> requests = aiMessage == null || aiMessage.getToolCalls() == null
                ? List.of() : aiMessage.getToolCalls();

        // 思考块：身份 thinking:<responseId>；旧数据用行 ID 兜底。
        String thinking = aiMessage == null ? null : aiMessage.getThinking();
        if (thinking != null && !thinking.isBlank()) {
            blocks.add(new ThinkingBlock(thinkingIdentity(responseId, aiRow.getId()), responseId,
                    BlockOrder.thinking(responseId, responseOrder), BlockStatus.COMPLETE, thinking));
        }

        // 正文块：placement 由「该行是否含工具请求」唯一判定。
        String text = aiMessage == null ? aiRow.getText() : aiMessage.text();
        if (text != null && !text.isBlank()) {
            Placement placement = Placement.resolve(requests);
            blocks.add(new TextBlock(textIdentity(responseId, aiRow.getId()), responseId,
                    BlockOrder.text(responseId, responseOrder), BlockStatus.COMPLETE, placement, text));
        }

        int requestIndex = 0;
        for (ToolCallRequest request : requests) {
            if (request == null || request.id() == null || request.id().isBlank()) {
                continue;
            }
            ToolCall toolCall = toolCalls == null ? null : toolCalls.get(request.id());
            blocks.add(buildToolBlock(responseId, BlockOrder.tool(responseId, responseOrder, requestIndex), request, toolCall));
            requestIndex++;
        }
    }

    /**
     * 构造工具块。
     *
     * <p>工具块身份来自 {@code toolCallId}，{@code responseId} 用于确定所属模型响应的位置。
     * 状态来自权威工具视图；工具调用行缺失（尚未落库的实时窗口）时按「已开始」展示，
     * 因为此刻它确实已被模型请求、只是还没有结论。</p>
     */
    private ToolBlock buildToolBlock(String responseId, int order, ToolCallRequest request, ToolCall toolCall) {
        String toolCallId = request.id();
        if (toolCall == null) {
            return new ToolBlock(ToolBlock.identity(toolCallId), responseId, order,
                    BlockStatus.TOOL_STARTED, toolCallId, request.name(), request.arguments(),
                    null, null, null);
        }
        return new ToolBlock(ToolBlock.identity(toolCallId), responseId, order,
                toolBlockStatusResolver.resolve(toolCall), toolCallId,
                toolCall.getToolName() == null ? request.name() : toolCall.getToolName(),
                request.arguments(), toolCall.getRawOutput(), null, null);
    }

    /**
     * 取本轮用户提问文本。
     *
     * <p>提问是会话级的「这一轮问了什么」，来自该轮最早的 USER 行；缺省返回 {@code null}。</p>
     */
    public String resolveUserMessage(Long turnId, List<SessionMessage> messages) {
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
        if (earliest == null) {
            return null;
        }
        UserMessageEntity user = parseUser(earliest.getText());
        return user == null ? earliest.getText() : user.text();
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
            if (!turnId.equals(message.getTurnId())) {
                continue;
            }
            if (message.getType() == SessionMessageType.TOOL) {
                // TOOL 行的 content 即 call_id（设计 §7.3）。
                if (message.getText() != null && !message.getText().isBlank()) {
                    ids.add(message.getText().trim());
                }
                continue;
            }
            if (message.getType() == SessionMessageType.AI) {
                AiMessageEntity aiMessage = parse(message.getText());
                if (aiMessage == null || aiMessage.getToolCalls() == null) {
                    continue;
                }
                for (ToolCallRequest request : aiMessage.getToolCalls()) {
                    if (request != null && request.id() != null && !request.id().isBlank()) {
                        ids.add(request.id());
                    }
                }
            }
        }
        return ids;
    }

    /** 思考块身份：有身份用 {@code thinking:<responseId>}，旧数据用行 ID 兜底（不伪造身份）。 */
    private static String thinkingIdentity(String responseId, Long rowId) {
        return responseId == null ? ThinkingBlock.legacyIdentity(rowId) : ThinkingBlock.identity(responseId);
    }

    private static String textIdentity(String responseId, Long rowId) {
        return responseId == null ? TextBlock.legacyIdentity(rowId) : TextBlock.identity(responseId);
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
