package com.summit.dp.agent.application.service;

import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.event.AgentEvent;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.block.BlockOrder;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** 同一响应只查询一次持久化序号；挂起保留位置，终结释放片段偏移。 */
@Component
@RequiredArgsConstructor
public class ResponseStreamState {
    private final MessageRepository messageRepository;
    private final Map<String, Map<UUID, Response>> executions = new ConcurrentHashMap<>();

    public Response resolve(AgentEvent event, UUID responseId, long sessionId) {
        Object rawTurnId = event.eventMetaData().get("turnId");
        return resolve(event.executionId(), responseId, sessionId, parseIdentity(rawTurnId));
    }

    private Response resolve(String executionId, UUID responseId, Long sessionId, Long turnId) {
        throwIf(responseId == null || turnId == null, "响应流缺少响应身份或轮次身份");
        Map<UUID, Response> responses = executions.computeIfAbsent(executionId, ignored -> new ConcurrentHashMap<>());
        return responses.computeIfAbsent(responseId, ignored -> {
            Integer persistedOrder = messageRepository.findByResponseId(sessionId, responseId)
                    .map(message -> message.getResponseOrder()).orElse(null);
            // 这里只读预览；同轮模型调用串行，序号的持久化分配仍由 transcript 的会话锁保护。
            int order = persistedOrder == null
                    ? Math.toIntExact(messageRepository.countAiMessagesInTurn(sessionId, turnId)) : persistedOrder;
            return new Response(order);
        });
    }

    public void registerTools(String executionId, Map<String, Object> metadata, ChatResponseEntity response) {
        List<ToolCallRequest> requests = response.getAiMessageEntity().getToolCalls();
        if (requests == null || requests.isEmpty()) return;
        Long sessionId = parseIdentity(metadata.get("sessionId"));
        Long turnId = parseIdentity(metadata.get("turnId"));
        throwIf(sessionId == null, "响应流缺少会话身份");
        Response position = resolve(executionId, response.getResponseId(), sessionId, turnId);
        synchronized (position) {
            int index = 0;
            for (ToolCallRequest request : requests) {
                if (request != null && request.id() != null && !request.id().isBlank()) position.tools.put(request.id(), index++);
            }
        }
    }

    private Long parseIdentity(Object raw) {
        return ExecutionIdentity.numericOrNull(raw == null ? null : raw.toString());
    }

    public void clearExecution(String executionId) {
        if (executionId != null) executions.remove(executionId);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    public static final class Response {
        private final int responseOrder;
        private int textOffset;
        private int thinkingOffset;
        private final Map<String, Integer> tools = new HashMap<>();

        private Response(int responseOrder) {
            this.responseOrder = responseOrder;
        }

        public synchronized int advance(boolean thinking, String text) {
            int start = thinking ? thinkingOffset : textOffset;
            if (thinking) thinkingOffset += text.length();
            else textOffset += text.length();
            return start;
        }

        public int thinkingOrder() {
            return BlockOrder.thinking(responseOrder);
        }

        public int textOrder() {
            return BlockOrder.text(responseOrder);
        }

        public synchronized int toolOrder(String requestId) {
            int index = tools.computeIfAbsent(requestId, ignored -> tools.size());
            return BlockOrder.tool(responseOrder, index);
        }
    }
}
