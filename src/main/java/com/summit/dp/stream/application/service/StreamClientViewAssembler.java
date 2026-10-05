package com.summit.dp.stream.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.application.convert.SessionMessageViewAssembler;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.execution.domain.model.Execution;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import java.time.Instant;

/** 执行只下发摘要，禁止把恢复检查点和模型上下文序列化给客户端。 */
@Component
@RequiredArgsConstructor
public class StreamClientViewAssembler {
    private final ObjectMapper json;
    private final ToolCallConverter toolConverter;
    private final ChatTurnConverter turnConverter;
    private final SessionMessageViewAssembler messageConverter;
    public ObjectNode session(Session session) {
        ObjectNode view = json.valueToTree(session);
        view.remove("messages");
        return view;
    }
    public ObjectNode turn(ChatTurn turn) {
        ObjectNode view = json.valueToTree(turnConverter.toVO(turn, Instant.now()));
        view.put("sessionId", String.valueOf(turn.getSessionId()));
        if (turn.getExecutionId() != null) view.put("executionId", String.valueOf(turn.getExecutionId()));
        view.remove("elapsedMs");
        return view;
    }
    public ObjectNode tool(ToolCall tool) { return json.valueToTree(toolConverter.toVO(tool)); }
    public ObjectNode execution(Execution execution) {
        ObjectNode view = json.createObjectNode();
        view.put("id", String.valueOf(execution.getId()));
        view.put("sessionId", String.valueOf(execution.getSessionId()));
        view.put("version", String.valueOf(execution.getVersion()));
        if (execution.getStatus() != null) view.put("status", execution.getStatus());
        view.set("startedAt", json.valueToTree(execution.getStartedAt()));
        view.set("completedAt", json.valueToTree(execution.getCompletedAt()));
        return view;
    }
    public ObjectNode message(SessionMessage message) {
        ObjectNode view = json.valueToTree(messageConverter.toVO(message));
        view.put("blockVersion", "1");
        view.put("committed", true);
        view.put("finalized", true);
        view.put("purpose", message.getType().name().equals("TOOL") || view.path("toolCalls").size() > 0 ? "process" : "answer");
        view.put("textOffset", view.path("text").asText("").length());
        view.put("thinkingOffset", view.path("thinking").asText("").length());
        return view;
    }
}
