package com.summit.dp.workflow.infrastructure.tools.sub_agent.communication;

import com.summit.core.agent.Execution;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.workflow.application.input.InputSource;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/** 邮件归属沿用原角色邮箱，消费方只能确认本次查询得到的消息。 */
@Component
@RequiredArgsConstructor
public class MailInputSource implements InputSource<EmailMessageVO> {
    private final EmailService emails;

    @Override
    public List<EmailMessageVO> pendingItems(Execution execution) {
        Map<String, Object> attributes = execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        Long mailbox = ExecutionAttributes.mailboxSessionId(attributes);
        Long recipient = ExecutionAttributes.readLong(attributes, ExecutionAttributes.AGENT_ID);
        if (mailbox == null || recipient == null) return List.of();
        return emails.pendingItems(mailbox, recipient);
    }

    @Override
    public boolean hasOpenDependency(Execution execution) {
        return false;
    }
}
