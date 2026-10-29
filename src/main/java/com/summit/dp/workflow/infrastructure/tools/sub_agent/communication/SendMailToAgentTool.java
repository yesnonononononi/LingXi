package com.summit.dp.workflow.infrastructure.tools.sub_agent.communication;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.OptionalBoolean;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.application.delegation.CommanderMailWakeService;
import com.summit.dp.workflow.infrastructure.tools.arguments.SendMailArgument;
import java.util.Map;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

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
@Tool(
    id = ToolCatalog.SEND_MAIL_TO_AGENT,
    name = ToolCatalog.SEND_MAIL_TO_AGENT,
    executor = SendMailToAgentTool.class,
    description = """
        Send an asynchronous mail to a teammate agent or to the commander.
        Use it to coordinate shared files or workspaces directly with teammates: agree on edit scope, order, and hand-offs without notifying the commander.
        The commander can mail running teammates supplementary requirements, constraints, or findings.
        Escalate only unresolved conflicts, task-scope changes, or blockers that require the commander's decision.
        The commander assesses workspace artifacts and validation records even without email; delivery notifications are supplementary.
        Delivery is asynchronous: the recipient reads this mail at the start of ITS next model round,
        not immediately. There is no reply channel on this call, so sending does not return an answer.
        After a successful send, continue with your own work, or if you have nothing left to do,
        end your turn; never resend the same content because no reply arrived yet.
        Mail does not start or resume a teammate. If a shared edit requires agreement, work on independent items until agreement arrives; do not assume silence grants permission to overwrite changes.
        Only mail addressed to the commander may wake the root execution; teammate mail does not notify or wake the commander.
        Intended for code-collaboration hand-offs, not for real-time back-and-forth chat.
        The target agent must belong to your team.
        """,
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "toAgentId", value = @Value(
                type = ValueType.INTEGER,
                description = "Agent id from the team roster: a teammate for coordination or supplementary information, or the commander for required decisions or delivery notifications.")),
            @ToolProperty(key = "mailContent", value = @Value(
                type = ValueType.STRING,
                description = "The mail body. Write it as a complete, self-contained message; the recipient cannot ask clarifying questions synchronously."))
        },
        required = {"toAgentId", "mailContent"},
        additionalProperties = OptionalBoolean.FALSE),
    concurrentPolicy = ConcurrentPolicy.ISOLATED_MUTATION,
    maxOutput = 20_000,
    timeout = 60L)
public class SendMailToAgentTool implements ToolExecutor {

    private final ObjectMapper objectMapper;
    private final EmailService emailService;
    /** 只唤醒邮件的实际收件主理人，队员互发与主理人补充信息不触发根执行。 */
    private final CommanderMailWakeService commanderMailWakeService;
    /**
     * 唤醒误用判定：主理人拿邮件叫一个没有在跑的队员时，在回执里当场点出来。
     *
     * <p>提示词已经禁止这种用法，但那是软约束。回执里那句「对方会在它自己的下一轮读到」在这种
     * 情况下是假话 —— 模型看不到投递结果，只会以为自己已经安排下去了。</p>
     */
    private final MailWakeMisuseDetector wakeMisuseDetector;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            // 模型只提供收件人和正文。
            SendMailArgument argument = objectMapper.readValue(toolExecution.getArgs(), SendMailArgument.class);

            // 路由身份由受控执行属性确定。
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

            // 邮件落库后再尝试唤醒，避免恢复时读不到正文。
            emailService.sendMail(toAgentId, mailContent, new MailSendContext(mailboxSessionId, senderAgentId, teamId));

            // 仅收件人为主理人时登记根执行唤醒，队员协调不能产生保留唤醒。
            // 唤醒失败只告警：邮件已经投出去了，不能把「唤醒没成功」报成「发信失败」——
            // 下面的回执文案明确要求模型不要重发，工具回 err 会让它怀疑投递失败而重发同一封。
            try {
                commanderMailWakeService.wakeIfRecipient(rootExecutionId, toAgentId);
            } catch (RuntimeException e) {
                log.warn("邮件投递后唤醒协作根执行失败: rootExecutionId={}, cause={}",
                        rootExecutionId, e.toString());
            }

            // 回执必须与工具 description 同口径：讲明「已投递 + 对方下一轮才读到 + 无回复通道 + 别重发」。
            // 模型看不到投递结果，含糊的回执会让它怀疑没发出去而重发同一封
            String receipt = String.format(
                    "Mail delivered to agent %d. It will be read at the start of that agent's next model round, if it runs again. Mail does not start or resume a teammate. "
                            + "This call returns no reply, so continue your own work or end your turn; do not resend the same content.",
                    toAgentId);
            // 主理人用邮件叫一个没有在跑的队员时，上面「对方下一轮读到」是假话 —— 追加提醒纠正，
            // 否则模型会以为任务已经安排下去（提示词里的禁令是软约束，这里给运行期反馈）。
            String reminder = wakeMisuseDetector.detect(attributes, toAgentId, mailboxSessionId).orElse(null);
            return ToolExecuteResult.success(reminder == null ? receipt : receipt + "\n" + reminder);

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
