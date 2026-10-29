package com.summit.dp.workflow.infrastructure.harness;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.List;

/** 从已提交历史注入补充，自动恢复提前读取的旧检查点也能收到要求。 */
@Component
@RequiredArgsConstructor
public class ResumeSupplementInterceptor implements LoopInterceptor {
    private final MessageRepository messages;
    private final ChatTurnService turns;
    private final ObjectMapper json;

    @Override
    public int order() { return -850; }

    @Override
    public boolean catchErr() { return false; }

    @Override
    public InterceptorResult onBeforeModelInvoke(LoopContext context) {

        Execution execution = context.getLoopMessages().getExecution();
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId == null) return InterceptorResult.NONE;

        ChatTurn turn = turns.findByExecutionId(executionId).orElse(null);
        if (turn == null) return InterceptorResult.NONE;

        Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        Long lastId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.LAST_RESUME_SUPPLEMENT_ID);

        for (SessionMessage record : messages.findResumeSupplements(turn.getSessionId(), turn.getId())) {
            if (lastId != null && record.getId() <= lastId) continue;
            try {
                context.appendMessage(List.of(json.readValue(record.getText(), UserMessageEntity.class)));
            } catch (JsonProcessingException error) {
                throw new IllegalStateException("读取已保存的补充要求失败", error);
            }
            // 游标随检查点保存，后续调用与压缩恢复不重复注入已读要求。
            attributes.put(ExecutionAttributes.LAST_RESUME_SUPPLEMENT_ID, record.getId());
            lastId = record.getId();
        }
        return InterceptorResult.NONE;
    }
}
