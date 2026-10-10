package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * 独立验证：{@code SendMailToAgentTool} 投递成功后必须唤醒收件方可能驻留的协作根执行，
 * 且「唤醒失败」绝不能污染「发信成功」的回执。
 *
 * <p>邮箱业务键是<b>协作根会话 id</b>，唤醒目标是<b>协作根执行 id</b> —— 两者身份不同：
 * 根执行取自身 SESSION_ID 与 executionId，子执行分别取 ROOT_SESSION_ID 与 ROOT_EXECUTION_ID。</p>
 */
class SendMailToAgentToolWakeTest {

    private static final long MAILBOX_SESSION_ID = 405L;
    private static final long ROOT_EXECUTION_ID = 900L;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final EmailService emailService = mock(EmailService.class);
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);
    private final SendMailToAgentTool tool =
            new SendMailToAgentTool(objectMapper, emailService, resumeCoordinator);

    @Test
    @DisplayName("根执行发信成功：投递一次并恰好唤醒一次 accept（邮箱键=根会话，唤醒目标=自身 executionId）")
    void deliveryTriggersExactlyOneWake() {
        ToolExecuteResult result = tool.execute(execution("900",
                Map.of(ExecutionAttributes.AGENT_ID, "100",
                        ExecutionAttributes.SESSION_ID, String.valueOf(MAILBOX_SESSION_ID)),
                "{\"toAgentId\":7,\"mailContent\":\"你好\"}"));

        assertTrue(result.isSuccess(), result.getToolOutput());
        verify(emailService).sendMail(7L, "你好", new MailSendContext(MAILBOX_SESSION_ID, 100L, null));
        verify(resumeCoordinator, times(1)).accept(ROOT_EXECUTION_ID);
    }

    @Test
    @DisplayName("子执行发信成功：邮箱键取 ROOT_SESSION_ID，唤醒的是 ROOT_EXECUTION_ID 对应的根执行")
    void childDeliveryWakesRootExecution() {
        ToolExecuteResult result = tool.execute(execution("1234",
                Map.of(ExecutionAttributes.AGENT_ID, "8",
                        ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(MAILBOX_SESSION_ID),
                        ExecutionAttributes.ROOT_EXECUTION_ID, "900"),
                "{\"toAgentId\":7,\"mailContent\":\"子代理发的\"}"));

        assertTrue(result.isSuccess(), result.getToolOutput());
        verify(emailService).sendMail(7L, "子代理发的", new MailSendContext(MAILBOX_SESSION_ID, 8L, null));
        verify(resumeCoordinator, times(1)).accept(ROOT_EXECUTION_ID);
        verify(resumeCoordinator, never()).accept(1234L);
    }

    @Test
    @DisplayName("【关键】accept 抛异常：邮件已投出 → 工具仍返回 success，且回执口径不变")
    void acceptFailureDoesNotPolluteSuccessReceipt() {
        doThrow(new IllegalStateException("恢复派发失败")).when(resumeCoordinator).accept(anyLong());

        ToolExecuteResult result = tool.execute(execution("900",
                Map.of(ExecutionAttributes.AGENT_ID, "100",
                        ExecutionAttributes.SESSION_ID, String.valueOf(MAILBOX_SESSION_ID)),
                "{\"toAgentId\":7,\"mailContent\":\"important\"}"));

        assertTrue(result.isSuccess(),
                "唤醒失败只告警：不能让「唤醒没成功」被报成「发信失败」，否则模型会重发同一封");
        assertTrue(result.getToolOutput().contains("delivered"));
        verify(emailService).sendMail(7L, "important", new MailSendContext(MAILBOX_SESSION_ID, 100L, null));
    }

    @Test
    @DisplayName("参数非法：不投递、不唤醒")
    void invalidArgumentsDoNotTouchServices() {
        Map<String, Object> attributes = Map.of(ExecutionAttributes.AGENT_ID, "100",
                ExecutionAttributes.SESSION_ID, String.valueOf(MAILBOX_SESSION_ID));

        assertFalse(tool.execute(execution("900", attributes, "{\"mailContent\":\"x\"}")).isSuccess());
        assertFalse(tool.execute(execution("900", attributes,
                "{\"toAgentId\":7,\"mailContent\":\"   \"}")).isSuccess());

        verifyNoInteractions(emailService);
        verifyNoInteractions(resumeCoordinator);
    }

    private static ToolExecution execution(String executionId, Map<String, Object> attributes, String args) {
        return ToolExecution.builder()
                .executionId(executionId)
                .attributes(attributes)
                .args(args)
                .build();
    }
}
