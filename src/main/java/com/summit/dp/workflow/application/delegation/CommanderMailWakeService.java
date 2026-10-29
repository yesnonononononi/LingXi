package com.summit.dp.workflow.application.delegation;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/** 按原根执行的身份判定收件人，队员间协调不能登记主理人的保留唤醒。 */
@Component
@RequiredArgsConstructor
public class CommanderMailWakeService {

    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final ExecutionResumeCoordinator resumeCoordinator;

    public void wakeIfRecipient(Long rootExecutionId, Long recipientAgentId) {
        Execution root = executionRepository.getObject().findById(String.valueOf(rootExecutionId))
                .orElseThrow(ClientException::new);
        throwIf(root.getAgentRequest() == null, "协作根执行缺少请求，无法确认邮件收件人");
        Long commanderAgentId = ExecutionAttributes.readLong(root.getAgentRequest().runtimeParametersOrDefault()
                .getAttributes(), ExecutionAttributes.AGENT_ID);
        throwIf(commanderAgentId == null, "协作根执行未绑定主理人，无法确认邮件收件人");
        if (commanderAgentId.equals(recipientAgentId)) {
            resumeCoordinator.accept(rootExecutionId);
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
