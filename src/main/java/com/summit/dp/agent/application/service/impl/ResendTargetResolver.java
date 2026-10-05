package com.summit.dp.agent.application.service.impl;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/**
 * 重发目标的定位与校验：定出那条被改写的用户提问所属的轮次，并截出它之前的上下文。
 *
 * <p>目标一律由 {@code messageId}（checkpoint）定位 —— 重发的语义是「编辑当时那条提问再发一次」，
 * 不是「重跑最新一轮」。</p>
 */
@Component
@RequiredArgsConstructor
public class ResendTargetResolver {

    private final SessionMessageQueryService sessionMessageQueryService;
    private final ChatTurnService chatTurnService;
    private final ExecutionQueryService executionQueryService;
    private final ObjectMapper objectMapper;

    /**
     * 定位重发目标。
     *
     * <p>归属按「消息 → 轮次 → 会话」逐级校验，不信请求自带的会话标识 ——
     * 否则可以拿 A 会话的消息标识去砍 B 会话的历史。</p>
     */
    public ResendTarget resolve(ChatCommand command) {
        throwIf(command.input() == null || command.input().isBlank(), "用户输入不能为空");
        throwIf(command.messageId() == null, "消息标识不能为空");
        throwIf(command.sessionId() == null, "会话标识不能为空");

        SessionMessageVO message = sessionMessageQueryService.findByMessageId(command.messageId()).getData();
        throwIf(message == null, "消息不存在");
        throwIf(!SessionMessageType.USER.name().equals(message.getType()), "只有用户提问可以重发");
        throwIf(message.getTurnId() == null, "该消息没有归属轮次，无法重发");

        ChatTurn turn = chatTurnService.findByIds(List.of(message.getTurnId())).get(message.getTurnId());
        throwIf(turn == null, "消息所属轮次不存在");
        throwIf(!command.sessionId().equals(turn.getSessionId()), "消息不属于该会话");
        // 子代理轮次的提问是委派方合成的，用户没有「改写它」这个动作。
        throwIf(turn.getParentTurnId() != null, "子代理轮次不支持重发");
        throwIf(turn.getExecutionId() == null, "该轮次没有关联执行，无法重发");

        return new ResendTarget(turn.getId(), resolveBaseline(turn.getExecutionId()));
    }

    /**
     * 截出「这条提问之前」的上下文。
     *
     * <p>截断点是快照里的最后一条用户消息：执行创建时的消息就是「当时的历史 + 本轮提问」，
     * 且同一执行内不会再追加用户消息，所以它必然是目标轮次自己的提问。</p>
     */
    private List<Message> resolveBaseline(Long executionId) {
        String snapshot = executionQueryService.findSnapshotById(executionId);
        throwIf(snapshot == null, "执行快照不存在，无法重发");

        Execution execution;
        try {
            execution = objectMapper.readValue(snapshot, Execution.class);
        } catch (JsonProcessingException e) {
            // 快照损坏是系统故障，不是用户能改正的业务错误，因此不套 ClientException。
            throw new IllegalStateException("执行快照无法解析: executionId=" + executionId, e);
        }

        List<Message> messages = execution.getMessages();
        throwIf(messages == null || messages.isEmpty(), "执行快照缺少历史上下文，无法重发");
        for (int i = messages.size() - 1; i >= 0; i--) {
            if (messages.get(i) instanceof UserMessageEntity) {
                // subList 到 i（不含）即「该提问之前」；必须复制，否则切片会一直持有整段快照。
                return new ArrayList<>(messages.subList(0, i));
            }
        }
        throw new ClientException("执行快照缺少用户提问，无法重发");
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    /** 重发目标：要作废并重跑的那一轮，以及它之前的上下文。 */
    public record ResendTarget(Long turnId, List<Message> baseline) {
    }
}
