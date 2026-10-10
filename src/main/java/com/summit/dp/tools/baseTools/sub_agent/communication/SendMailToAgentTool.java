package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.tools.baseTools.arguments.SendMailArgument;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 发信工具：把一封邮件投递到「本次协作轮次里、收件 Agent 的角色邮箱」。
 *
 * <p>模型只提供 {@code toAgentId} 与 {@code mailContent}。发送者 Agent ID、协作根会话 ID（邮箱业务键）
 * 与协作根执行 ID（唤醒目标）由服务端从当前 {@link ToolExecution} 的受控属性解析：根会话 / 根执行在
 * 根执行上回落各自的自身值，在子执行上分别取 {@code ROOT_SESSION_ID} / {@code ROOT_EXECUTION_ID}。
 * 因此模型无法伪造路由字段，也不会出现「发送者 ID 形态不一致」（历史上曾直接强转 Long，
 * 而主/子执行写入的是字符串）。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SendMailToAgentTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final EmailService emailService;
    /**
     * 投递后唤醒收件方可能正在驻留等待的协作根执行。
     *
     * <p>协作模式下根代理会在「本轮无工具调用、但仍有子代理在跑」时保留轮次驻留（SUSPENDED），
     * 这封邮件是它唯一的续跑信号；少了这一步，邮件只会停在 PENDING，根执行再也醒不过来。
     * {@code accept} 自身幂等：收件方未挂起（运行中 / 已终态 / 无恢复边界）时一律让位，不会重复启动 loop。</p>
     */
    private final ExecutionResumeCoordinator resumeCoordinator;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            // parse argument
            SendMailArgument argument = objectMapper.readValue(toolExecution.getArgs(), SendMailArgument.class);

            // resolve business attributes
            Long toAgentId = argument.getToAgentId();
            String mailContent = argument.getMailContent();
            if (toAgentId == null)  return ToolExecuteResult.err("toAgentId is required");
            if (mailContent == null || mailContent.isBlank()) return ToolExecuteResult.err("Email content cannot be empty");
            Map<String, Object> attributes = toolExecution.getAttributes();
            Long senderAgentId = requireAgentId(toolExecution);
            // 邮箱业务键 = 协作根会话 id；唤醒目标是协作根执行 id —— 两者身份不同，不可混用。
            Long mailboxSessionId = requireMailboxSessionId(toolExecution);
            Long rootExecutionId = requireRootExecutionId(toolExecution);
            Long teamId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.TEAM_ID);

            // send mail
            emailService.sendMail(toAgentId, mailContent, new MailSendContext(mailboxSessionId, senderAgentId, teamId));

            // 投递即尝试唤醒收件方的协作根执行：若它正驻留等待（SUSPENDED）则恢复续跑，否则 accept 自行让位。
            // 唤醒失败只告警：邮件已经投出去了，不能把「唤醒没成功」报成「发信失败」——
            // 下面的回执文案明确要求模型不要重发，工具回 err 会让它怀疑投递失败而重发同一封。
            try {
                resumeCoordinator.accept(rootExecutionId);
            } catch (RuntimeException e) {
                log.warn("邮件投递后唤醒协作根执行失败: rootExecutionId={}, cause={}",
                        rootExecutionId, e.toString());
            }

            // 回执必须与工具 description 同口径：讲明「已投递 + 对方下一轮才读到 + 无回复通道 + 别重发」。
            // 模型看不到投递结果，含糊的回执会让它怀疑没发出去而重发同一封
            return ToolExecuteResult.success(String.format(
                    "Mail delivered to agent %d. It will be read at the start of that agent's next model round. "
                            + "This call returns no reply, so continue your own work or end your turn; do not resend the same content.",
                    toAgentId));


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

    /** 邮箱业务键：协作根会话 id（子执行取 ROOT_SESSION_ID，根执行回落自身 SESSION_ID）。 */
    private @NonNull Long requireMailboxSessionId(@NonNull ToolExecution toolExecution){
        Long mailboxSessionId = ExecutionAttributes.mailboxSessionId(toolExecution.getAttributes());
        if (mailboxSessionId == null) {
            throw new RuntimeException("无法解析协作根会话 ID，无法发信");
        }
        return mailboxSessionId;
    }

    /** 唤醒目标：协作根执行 id（子执行取 ROOT_EXECUTION_ID，根执行回落自身 executionId）。 */
    private @NonNull Long requireRootExecutionId(@NonNull ToolExecution toolExecution){
        Long rootExecutionId = ExecutionAttributes.workflowExecutionId(toolExecution.getAttributes(), toolExecution.getExecutionId());
        if (rootExecutionId == null) {
            throw new RuntimeException("无法解析协作根执行 ID，无法发信");
        }
        return rootExecutionId;
    }
}
