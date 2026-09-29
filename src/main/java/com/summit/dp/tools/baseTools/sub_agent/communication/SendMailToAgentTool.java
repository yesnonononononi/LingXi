package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.tools.baseTools.arguments.SendMailArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 发信工具：把一封邮件投递到「本次协作轮次里、收件 Agent 的角色邮箱」。
 *
 * <p>模型只提供 {@code toAgentId} 与 {@code mailContent}。发送者 Agent ID 与协作根执行 ID
 * 由服务端从当前 {@link ToolExecution} 的受控属性解析（根执行没有 {@code ROOT_EXECUTION_ID}
 * 属性时取自身 executionId），因此模型无法伪造路由字段，也不会出现「发送者 ID 形态不一致」
 * （历史上曾直接强转 Long，而主/子执行写入的是字符串）。</p>
 */
@Component
@RequiredArgsConstructor
public class SendMailToAgentTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final EmailService emailService;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            SendMailArgument argument = objectMapper.readValue(toolExecution.getArgs(), SendMailArgument.class);

            Long toAgentId = argument.getToAgentId();
            String mailContent = argument.getMailContent();

            if (toAgentId == null) {
                return ToolExecuteResult.err("toAgentId is required");
            }
            if (mailContent == null || mailContent.isBlank()) {
                return ToolExecuteResult.err("Email content cannot be empty");
            }

            Map<String, Object> attributes = toolExecution.getAttributes();
            Long senderAgentId = requireAgentId(toolExecution);

            Long workflowExecutionId = requireWorkflowExecutionId(toolExecution);

            Long teamId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.TEAM_ID);

            emailService.sendMail(toAgentId, mailContent,new MailSendContext(workflowExecutionId, senderAgentId, teamId));

            return ToolExecuteResult.success("Email sent successfully");
        } catch (JsonProcessingException e) {
            throw new RuntimeException(e);
        } catch (Exception e) {
            return ToolExecuteResult.err(e.getMessage());
        }
    }

    private @NonNull Long requireAgentId(@NonNull ToolExecution toolExecution){
        Long senderAgentId = ExecutionAttributes.readLong(toolExecution.getAttributes(), ExecutionAttributes.AGENT_ID);
        if (senderAgentId == null) {
            throw new RuntimeException("当前执行未绑定 Agent，无法发信");
        }
        return senderAgentId;
    }
    private @NonNull Long requireWorkflowExecutionId(@NonNull ToolExecution toolExecution){
        Long workflowExecutionId = ExecutionAttributes.workflowExecutionId(toolExecution.getAttributes(), toolExecution.getExecutionId());
        if (workflowExecutionId == null) {
            throw new RuntimeException("无法解析协作根执行 ID，无法发信");
        }
        return workflowExecutionId;
    }
}
