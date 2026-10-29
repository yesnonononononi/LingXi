package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.dp.workflow.infrastructure.harness.ExecutionStateCodec;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.Map;

/** 完成提醒归属原根执行，不能因团队配置变更而换收件人。 */
@Component
@RequiredArgsConstructor
public class SubAgentCompleteNotifier {

    private final ObjectProvider<ExecutionRepository> executionRepository;
    private final EmailService emailService;

    public void notifyCommander(Execution subExecution) {
        throwIf(subExecution == null || subExecution.getAgentRequest() == null, "子执行及其请求不能为空");

        throwIf(!ExecutionStateCodec.isTerminalState(subExecution.getExecutionState()), "只有已结束的子执行可以发送终结提醒");

        Long childExecutionId = ExecutionIdentity.numericOrNull(subExecution.getId());

        throwIf(childExecutionId == null, "子执行标识必须是数字");

        Map<String, Object> attributes = subExecution.getAgentRequest().runtimeParametersOrDefault().getAttributes();

        Long rootExecutionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.ROOT_EXECUTION_ID);

        Long rootSessionId = ExecutionAttributes.mailboxSessionId(attributes);

        Long senderAgentId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.AGENT_ID);

        Long teamId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.TEAM_ID);

        throwIf(rootExecutionId == null || rootSessionId == null, "子执行缺少协作根执行或根会话标识");

        throwIf(senderAgentId == null, "子执行未绑定业务成员");

        Execution root = executionRepository.getObject().findById(String.valueOf(rootExecutionId))
                .orElseThrow(ClientException::new);
        Long commanderId = ExecutionAttributes.readLong(root.getAgentRequest().runtimeParametersOrDefault()
                .getAttributes(), ExecutionAttributes.AGENT_ID);
        throwIf(commanderId == null, "协作根执行未绑定主理人");
        String outcome = switch (subExecution.getExecutionState()) {
            case COMPLETED -> "已完成";
            case FAILED -> "执行失败";
            case CANCELLED -> "已取消";
            default -> throw new ClientException("子执行尚未结束");
        };
        String content = String.format("成员 @%s 的子任务%s（子会话：%s，执行：%s）。请核验工作目录中的产物并继续后续安排。",
                senderAgentId, outcome, ExecutionIdentity.sessionId(subExecution), childExecutionId);
        if (subExecution.getExecutionState() == ExecutionState.FAILED) {
            // 框架失败检查点已保存异常 getMessage()，通知沿用原文，避免丢掉诊断信息。
            String errorMessage = subExecution.getErrorMessage();
            content += "\n异常信息：" + (errorMessage == null || errorMessage.isBlank() ? "异常未提供详细信息" : errorMessage)
                    + "\n请立即评估失败影响，检查现有产物，采取修复、补做或重新委派等措施；其他仍在执行的子任务无需重复委派。";
        }

        String dedupKey = "sub-agent-finished:" + childExecutionId + ":" + commanderId;

        emailService.sendMailOnce(commanderId, content, new MailSendContext(rootSessionId, senderAgentId, teamId), dedupKey);
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

}
