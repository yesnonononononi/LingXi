package com.summit.dp.workflow.application.resume;

import cn.hutool.core.util.IdUtil;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Objects;

/** 补充先与恢复请求一起提交；模型调用不占用受理锁。 */
@Service
@RequiredArgsConstructor
public class ResumeSupplementService {
    private final ChatTurnService turns;
    private final MessageRepository messages;
    private final ObjectProvider<ExecutionRepository> executions;
    private final ObjectProvider<ExecutionActivity> activity;
    private final SuspendedExecutionResumer resumer;
    private final ExecutionResumeCoordinator coordinator;
    private final TransactionTemplate transactions;
    private final ObjectMapper json;

    public String accept(Long sessionId, ResumeSupplementCommand command) {
        throwIf(sessionId == null || sessionId <= 0, "会话标识不合法");
        throwIf(command == null || command.turnId() == null || command.turnId() <= 0, "请先同步当前轮次后再补充要求");
        throwIf(command.requestId() == null || !command.requestId().matches("[a-zA-Z0-9-]{16,64}"), "补充请求标识不合法");
        throwIf(command.input() == null || command.input().isBlank(), "补充要求不能为空");
        String input = command.input().trim();
        throwIf(input.length() > SessionMessage.MAX_SUPPLEMENT_LENGTH, "补充要求不能超过 20000 字");
        ChatTurn turn = turns.findByIds(List.of(command.turnId())).get(command.turnId());
        throwIf(turn == null || !sessionId.equals(turn.getSessionId()) || turn.getExecutionId() == null,
                "补充要求对应的轮次不存在或不属于当前会话");
        String executionId = String.valueOf(turn.getExecutionId());

        // 与框架登记共用门闩，事务提交后才允许自动恢复取得控制槽位。
        synchronized (ExecutionCoordination.monitor(executionId)) {
            return transactions.execute(status -> {
                messages.lockSessionForAppend(sessionId);
                SessionMessage existing = messages.findByResumeRequestId(sessionId, command.requestId()).orElse(null);
                String content;
                try {
                    content = json.writeValueAsString(UserMessageEntity.from(input));
                } catch (JsonProcessingException error) {
                    throw new ClientException("保存补充要求失败，请重试");
                }
                if (existing != null) {
                    throwIf(!Objects.equals(existing.getTurnId(), command.turnId()) || !content.equals(existing.getText()),
                            "同一补充请求不能修改内容或轮次，请重新提交");
                    return String.valueOf(existing.getId());
                }

                Execution execution = executions.getObject().findById(executionId).orElseThrow(ClientException::new);
                throwIf(ExecutionIdentity.sessionId(execution) != sessionId, "执行不属于当前会话");
                throwIf(activity.getObject().isActive(executionId) || execution.getExecutionState() != ExecutionState.SUSPENDED,
                        "主会话已恢复或结束，补充要求尚未提交，输入内容已保留");
                throwIf(resumer.hasUnresolvedSlot(turn.getExecutionId()), "请先处理待审批或待回答的卡片");
                SessionMessage message = SessionMessage.builder().id(IdUtil.getSnowflakeNextId())
                        .sessionId(sessionId).turnId(command.turnId()).type(SessionMessageType.USER)
                        .resumeRequestId(command.requestId()).text(content).createTime(Instant.now()).build();
                messages.appendAll(sessionId, sessionId, List.of(message));
                coordinator.accept(turn.getExecutionId());
                return String.valueOf(message.getId());
            });
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
