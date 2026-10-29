package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.workflow.application.delegation.CommanderMailWakeService;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.MailWakeMisuseDetector;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.SendMailToAgentTool;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/** 使用真实收件人判定，防止队员互发邮件时登记根执行的即时或保留唤醒。 */
class SendMailToAgentToolWakeTest {
    private static final long MAILBOX_SESSION_ID = 405L;
    private static final long ROOT_EXECUTION_ID = 900L;
    private static final long COMMANDER_AGENT_ID = 100L;

    private final EmailService emailService = mock(EmailService.class);
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ObjectProvider<ExecutionRepository> executionProvider =
            new StaticListableBeanFactory(Map.of("executions", executionRepository)).getBeanProvider(ExecutionRepository.class);
    private final SendMailToAgentTool tool = new SendMailToAgentTool(new ObjectMapper(), emailService,
            new CommanderMailWakeService(executionProvider, resumeCoordinator), mock(MailWakeMisuseDetector.class));

    @BeforeEach
    void rootIdentityComesFromItsExecutionSnapshot() {
        Execution root = Execution.builder().id(String.valueOf(ROOT_EXECUTION_ID))
                .agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.AGENT_ID, String.valueOf(COMMANDER_AGENT_ID))).build()).build())
                .build();
        when(executionRepository.findById(String.valueOf(ROOT_EXECUTION_ID))).thenReturn(Optional.of(root));
    }

    @Test
    void memberMailToTeammateDoesNotWakeOrRegisterPendingWakeForCommander() {
        ToolExecuteResult result = tool.execute(execution("1234", memberAttributes(), 7L));
        assertTrue(result.isSuccess(), result.getToolOutput());
        verify(emailService).sendMail(7L, "补充信息", new MailSendContext(MAILBOX_SESSION_ID, 8L, 3L));
        verifyNoInteractions(resumeCoordinator);
    }

    @Test
    void commanderSupplementToMemberDoesNotWakeItself() {
        ToolExecuteResult result = tool.execute(execution("900", commanderAttributes(), 7L));
        assertTrue(result.isSuccess(), result.getToolOutput());
        verify(emailService).sendMail(7L, "补充信息", new MailSendContext(MAILBOX_SESSION_ID, COMMANDER_AGENT_ID, 3L));
        verifyNoInteractions(resumeCoordinator);
    }

    @Test
    void memberMailToCommanderWakesOnlyRootAfterDelivery() {
        ToolExecuteResult result = tool.execute(execution("1234", memberAttributes(), COMMANDER_AGENT_ID));
        assertTrue(result.isSuccess(), result.getToolOutput());
        InOrder order = inOrder(emailService, resumeCoordinator);
        order.verify(emailService).sendMail(COMMANDER_AGENT_ID, "补充信息", new MailSendContext(MAILBOX_SESSION_ID, 8L, 3L));
        order.verify(resumeCoordinator).accept(ROOT_EXECUTION_ID);
        order.verifyNoMoreInteractions();
    }

    @Test
    void wakeFailureDoesNotTurnDeliveredMailIntoFailure() {
        doThrow(new IllegalStateException("恢复派发失败")).when(resumeCoordinator).accept(anyLong());
        ToolExecuteResult result = tool.execute(execution("1234", memberAttributes(), COMMANDER_AGENT_ID));
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("delivered"));
        verify(emailService).sendMail(COMMANDER_AGENT_ID, "补充信息", new MailSendContext(MAILBOX_SESSION_ID, 8L, 3L));
    }

    @Test
    void missingRootDoesNotGuessCommanderOrLoseDeliveredMail() {
        when(executionRepository.findById(String.valueOf(ROOT_EXECUTION_ID))).thenReturn(Optional.empty());
        ToolExecuteResult result = tool.execute(execution("1234", memberAttributes(), COMMANDER_AGENT_ID));
        assertTrue(result.isSuccess(), result.getToolOutput());
        verify(emailService).sendMail(COMMANDER_AGENT_ID, "补充信息", new MailSendContext(MAILBOX_SESSION_ID, 8L, 3L));
        verifyNoInteractions(resumeCoordinator);
    }

    @Test
    void failedDeliveryDoesNotWakeCommander() {
        doThrow(new IllegalStateException("投递失败")).when(emailService)
                .sendMail(COMMANDER_AGENT_ID, "补充信息", new MailSendContext(MAILBOX_SESSION_ID, 8L, 3L));
        assertFalse(tool.execute(execution("1234", memberAttributes(), COMMANDER_AGENT_ID)).isSuccess());
        verifyNoInteractions(resumeCoordinator, executionRepository);
    }

    @Test
    void invalidArgumentsDoNotDeliverOrWake() {
        ToolExecution invalid = ToolExecution.builder().executionId("900").attributes(commanderAttributes())
                .args("{\"mailContent\":\"x\"}").build();
        assertFalse(tool.execute(invalid).isSuccess());
        verifyNoInteractions(emailService, resumeCoordinator, executionRepository);
    }

    private static Map<String, Object> commanderAttributes() {
        return Map.of(ExecutionAttributes.AGENT_ID, String.valueOf(COMMANDER_AGENT_ID),
                ExecutionAttributes.SESSION_ID, String.valueOf(MAILBOX_SESSION_ID), ExecutionAttributes.TEAM_ID, "3");
    }

    private static Map<String, Object> memberAttributes() {
        return Map.of(ExecutionAttributes.AGENT_ID, "8", ExecutionAttributes.SESSION_ID, "7002",
                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(MAILBOX_SESSION_ID),
                ExecutionAttributes.ROOT_EXECUTION_ID, String.valueOf(ROOT_EXECUTION_ID), ExecutionAttributes.TEAM_ID, "3");
    }

    private static ToolExecution execution(String executionId, Map<String, Object> attributes, long recipientAgentId) {
        return ToolExecution.builder().executionId(executionId).attributes(attributes)
                .args(String.format("{\"toAgentId\":%d,\"mailContent\":\"补充信息\"}", recipientAgentId)).build();
    }
}
