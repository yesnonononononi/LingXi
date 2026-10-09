package com.summit.dp.session.application.convert;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.*;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/** 序列化必须在写入前完成，后续上下文压缩不能改变已接纳历史。 */
@Component
@RequiredArgsConstructor
public class TranscriptRecordAssembler {
    private final ObjectMapper json;

    public List<SessionMessage> build(Long sessionId, Long turnId, List<? extends Message> source, String responseId) {
        List<SessionMessage> records = new ArrayList<>();
        for (Message message : source) {
            SessionMessageType type = toMessageType(message);
            String content;
            if (message instanceof ToolMessageEntity tool) content = String.valueOf(tool.getId());
            else {
                try { content = json.writeValueAsString(message); }
                catch (JsonProcessingException error) { throw new ClientException("记录会话消息失败，请重试"); }
            }
            records.add(SessionMessage.builder().id(IdUtil.getSnowflakeNextId()).sessionId(sessionId)
                    .turnId(turnId).type(type).text(content).createTime(Instant.now())
                    // 身份只挂在 AI 行：一轮里多个工具行共享同一个 responseId，重复值会撞唯一索引。
                    // 幂等本来就以「轮」为单位判定，不需要工具行各存一份。
                    .responseId(type == SessionMessageType.AI ? responseId : null).build());
        }
        return records;
    }

    private static SessionMessageType toMessageType(Message message) {
        if (message instanceof UserMessageEntity) return SessionMessageType.USER;
        if (message instanceof AiMessageEntity) return SessionMessageType.AI;
        if (message instanceof ToolMessageEntity) return SessionMessageType.TOOL;
        return SessionMessageType.SYSTEM;
    }
}
