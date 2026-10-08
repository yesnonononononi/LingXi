package com.summit.dp.session.application.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/**
 * 判定「同一 responseId 的第二次落库」是否与已落库那一轮**内容一致**。
 *
 * <p>幂等拦截不能只看「responseId 已存在」就放行：那样会把真实的内容漂移静默吞掉 ——
 * 同一身份两次落库内容不同，说明有人的状态算错了，必须让人看见，而不是悄悄丢弃第二次。
 * 本类只回答一个问题：两次落库是不是同一轮输出的重放。</p>
 *
 * <p><b>比对口径</b>（依据用户敲定的边界）：</p>
 * <ul>
 *   <li>比对：轮次归属 + AI 内容（thinking / text）+ 工具请求身份（callId 集合）。</li>
 *   <li>排除：新生成的行主键、创建/更新时间 —— 每次插入都会变，拿来比对会把合法重放误判成漂移。</li>
 *   <li>放行：审批恢复后**追加**工具结果是同一轮的合法补充，因此只要求「已落库的工具身份 ⊆ 新到的工具身份」，
 *       新增工具行不构成漂移；反过来（新到的缺少已落库的）才是漂移。</li>
 * </ul>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class TranscriptReplayMatcher {
    private final ObjectMapper json;

    /**
     * 比对已落库的 AI 行与本次要落的 AI 内容。
     *
     * @param existing  已落库的 AI 行（非空）
     * @param turnId    本次要落的轮次归属，可为 null（旧数据归属未知）
     * @param aiMessage 本次要落的 AI 内容
     * @return true = 同一轮输出的重放，可安全幂等返回；false = 内容漂移
     */
    public boolean isSameRound(SessionMessage existing, Long turnId, AiMessageEntity aiMessage) {
        if (!Objects.equals(existing.getTurnId(), turnId)) return false;
        AiMessageEntity stored = parseAi(existing);
        if (stored == null) return false;
        if (!Objects.equals(trimToNull(stored.getText()), trimToNull(aiMessage.getText()))) return false;
        if (!Objects.equals(trimToNull(stored.getThinking()), trimToNull(aiMessage.getThinking()))) return false;
        return toolIdsOf(stored).equals(toolIdsOf(aiMessage));
    }

    /** 内容不一致时的统一报错文案（抛给全局异常处理器，作为业务提示暴露）。 */
    public ClientException driftError(Long sessionId, UUID responseId) {
        return new ClientException("同一轮模型输出被重复提交但内容不一致，已拒绝落库: sessionId="
                + sessionId + ", responseId=" + responseId);
    }

    private AiMessageEntity parseAi(SessionMessage existing) {
        String raw = existing.getText();
        if (raw == null || raw.isBlank()) return null;
        try {
            return json.readValue(raw, AiMessageEntity.class);
        } catch (Exception error) {
            log.warn("解析已落库 AI 行失败，按内容漂移处理: messageId={}, error={}", existing.getId(), error.toString());
            return null;
        }
    }

    /** 工具请求身份集合，按 id 排序以便稳定比较（顺序不同不算漂移）。 */
    private static Set<String> toolIdsOf(AiMessageEntity message) {
        Set<String> ids = new TreeSet<>();
        List<ToolCallRequest> calls = message.getToolCalls();
        if (calls == null) return ids;
        for (ToolCallRequest call : calls) {
            if (call != null && call.id() != null) ids.add(call.id());
        }
        return ids;
    }

    private static String trimToNull(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }

    /** 工具行身份集合（callId 即 tool_call 表主键），用于比对已落库工具行是否被新批次覆盖。 */
    public static Set<String> toolResultIds(List<ToolMessageEntity> toolMessages) {
        Set<String> ids = new TreeSet<>();
        if (toolMessages == null) return ids;
        for (ToolMessageEntity message : toolMessages) {
            if (message != null && message.getId() != null) ids.add(String.valueOf(message.getId()));
        }
        return ids;
    }
}
