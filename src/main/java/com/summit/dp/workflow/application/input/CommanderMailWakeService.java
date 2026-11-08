package com.summit.dp.workflow.application.input;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

/** 按原根执行确认主理人身份，队员间投递不触发主理人复查。 */
@Component
@RequiredArgsConstructor
public class CommanderMailWakeService {

    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final InputWakeupService wakeups;

    public void wakeIfRecipient(Long rootExecutionId, Long recipientAgentId) {
        Execution root = executionRepository.getObject().findById(String.valueOf(rootExecutionId))
                .orElseThrow(ClientException::new);
        Long commanderAgentId = ExecutionAttributes.readLong(root.getAgentRequest().runtimeParametersOrDefault()
                .getAttributes(), ExecutionAttributes.AGENT_ID);
        throwIf(commanderAgentId == null, "协作根执行未绑定主理人，无法确认邮件收件人");
        if (commanderAgentId.equals(recipientAgentId)) {
            wakeups.resumeIfInputPending(rootExecutionId);
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
