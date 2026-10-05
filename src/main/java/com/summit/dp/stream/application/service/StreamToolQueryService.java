package com.summit.dp.stream.application.service;

import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.stream.application.protocol.StreamSnapshot;
import com.summit.dp.stream.application.protocol.StreamToolProjection;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import java.util.List;
import java.util.Optional;

/** 单卡刷新复用根投影的动作版本，旧历史只补持久化字段。 */
@Service
@RequiredArgsConstructor
public class StreamToolQueryService {
    private final ToolCallRepository tools;
    private final SessionRepository sessions;
    private final SessionStreamHub hub;
    private final StreamClientViewAssembler views;

    public Optional<StreamToolProjection> findById(String callId) {
        throwIf(callId == null || callId.isBlank(), "工具调用标识不能为空");
        Optional<ToolCall> stored = tools.findById(callId);
        if (stored.isEmpty()) return Optional.empty();
        Session session = sessions.findById(stored.get().getConversationId()).orElseThrow(ClientException::new);
        long rootId = session.isSubSession() ? session.getRootSessionId() : session.getId();
        StreamSnapshot snapshot = hub.snapshot(rootId);
        Optional<ObjectNode> projected = snapshot.toolCalls().stream().filter(tool -> callId.equals(tool.path("id").asText())).findFirst();
        if (projected.isPresent()) return Optional.of(new StreamToolProjection(2, snapshot.streamEpoch(), snapshot.watermark(),
                snapshot.historyRevision(), false, projected.get()));

        Optional<ToolCall> latest = tools.findById(callId);
        Session root = sessions.findById(rootId).orElseThrow(ClientException::new);
        throwIf(!snapshot.historyRevision().equals(String.valueOf(root.getHistoryRevision())), "历史正在变更，请重新查询工具状态");
        if (latest.isEmpty()) return Optional.empty();
        ObjectNode persistent = views.tool(latest.get());
        persistent.remove(List.of("allowedActions", "unavailableReason", "projectionStamp", "executionVersion"));
        return Optional.of(new StreamToolProjection(2, snapshot.streamEpoch(), snapshot.watermark(), snapshot.historyRevision(), true, persistent));
    }
    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }
}
