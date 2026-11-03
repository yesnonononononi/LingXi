package com.summit.dp.agent.infrastructure.runtime;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.lifecycle.SubAgentCompleteNotifier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;

import java.util.Map;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class SubAgentCompleteNotifierTest {

    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final EmailService emails = mock(EmailService.class);
    private final ObjectProvider<ExecutionRepository> provider = mock(ObjectProvider.class);

    @Test
    void usesBusinessAgentAndRootSessionWithExecutionScopedKey() {
        when(provider.getObject()).thenReturn(executions);
        when(executions.findById("900")).thenReturn(Optional.of(root()));
        SubAgentCompleteNotifier notifier = new SubAgentCompleteNotifier(provider, emails);
        notifier.notifyCommander(child("1234", ExecutionState.COMPLETED));
        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(emails).sendMailOnce(eq(7L), content.capture(), eq(new MailSendContext(800L, 8L, 2L)),
                eq("sub-agent-finished:1234:7"));
        assertTrue(content.getValue().contains("成员 @8 的子任务已完成"));
        assertTrue(content.getValue().contains("子会话：555"));
        assertTrue(content.getValue().contains("执行：1234"));
        notifier.notifyCommander(child("1235", ExecutionState.COMPLETED));
        verify(emails).sendMailOnce(eq(7L), any(), eq(new MailSendContext(800L, 8L, 2L)),
                eq("sub-agent-finished:1235:7"));
    }

    @Test
    void reportsFailureAndCancellationWithoutClaimingSuccess() {
        when(provider.getObject()).thenReturn(executions);
        when(executions.findById("900")).thenReturn(Optional.of(root()));
        SubAgentCompleteNotifier notifier = new SubAgentCompleteNotifier(provider, emails);
        notifier.notifyCommander(child("1234", ExecutionState.FAILED));
        notifier.notifyCommander(child("1235", ExecutionState.CANCELLED));
        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(emails).sendMailOnce(eq(7L), content.capture(), any(), eq("sub-agent-finished:1234:7"));
        assertTrue(content.getValue().contains("执行失败"));
        verify(emails).sendMailOnce(eq(7L), content.capture(), any(), eq("sub-agent-finished:1235:7"));
        assertTrue(content.getValue().contains("已取消"));
    }

    @Test
    void failedNoticeContainsExceptionMessageAndAsksCommanderToAct() {
        when(provider.getObject()).thenReturn(executions);
        when(executions.findById("900")).thenReturn(Optional.of(root()));
        SubAgentCompleteNotifier notifier = new SubAgentCompleteNotifier(provider, emails);
        IllegalStateException failure = new IllegalStateException("HTTP 429: retry quota exhausted");
        Execution failed = child("1234", ExecutionState.RUNNING);
        failed.fail(failure.getMessage());

        notifier.notifyCommander(failed);

        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(emails).sendMailOnce(eq(7L), content.capture(), eq(new MailSendContext(800L, 8L, 2L)),
                eq("sub-agent-finished:1234:7"));
        assertTrue(content.getValue().contains("异常信息：" + failure.getMessage()));
        assertTrue(content.getValue().contains("请立即评估失败影响"));
        assertTrue(content.getValue().contains("修复、补做或重新委派"));
    }

    @Test
    void failedNoticeWithNoExceptionMessageExplainsMissingDetail() {
        when(provider.getObject()).thenReturn(executions);
        when(executions.findById("900")).thenReturn(Optional.of(root()));
        SubAgentCompleteNotifier notifier = new SubAgentCompleteNotifier(provider, emails);
        Execution failed = child("1234", ExecutionState.RUNNING);
        failed.fail(new IllegalStateException().getMessage());

        notifier.notifyCommander(failed);

        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(emails).sendMailOnce(eq(7L), content.capture(), any(), eq("sub-agent-finished:1234:7"));
        assertTrue(content.getValue().contains("异常信息：异常未提供详细信息"));
    }

    @Test
    void suspensionCannotSendTerminalNotice() {
        SubAgentCompleteNotifier notifier = new SubAgentCompleteNotifier(provider, emails);
        assertThrows(ClientException.class, () -> notifier.notifyCommander(child("1234", ExecutionState.SUSPENDED)));
        verify(emails, never()).sendMailOnce(any(), any(), any(), any());
        verify(provider, never()).getObject();
    }

    @ParameterizedTest
    @EnumSource(value = ExecutionState.class, names = {"COMPLETED", "FAILED", "CANCELLED"})
    void terminalNoticeForwardsFinalTextWithoutThinking(ExecutionState state) {
        when(provider.getObject()).thenReturn(executions);
        when(executions.findById("900")).thenReturn(Optional.of(root()));
        Execution finished = child("1234", state);
        String finalText = "验收通过。\n报告：.lingxi/qa-report.md\n" + "验证记录与产物路径。".repeat(600);
        finished.setAiMessage(AiMessageEntity.builder().text(finalText).thinking("内部思考内容").build());

        new SubAgentCompleteNotifier(provider, emails).notifyCommander(finished);

        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(emails).sendMailOnce(eq(7L), content.capture(), eq(new MailSendContext(800L, 8L, 2L)),
                eq("sub-agent-finished:1234:7"));
        assertTrue(content.getValue().startsWith("【系统自动通知】"));
        assertTrue(content.getValue().endsWith("子 Agent 最终答复（系统转交原文）：\n" + finalText));
        assertFalse(content.getValue().contains("内部思考内容"));
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"  \n\t"})
    void missingFinalTextIsExplicit(String text) {
        when(provider.getObject()).thenReturn(executions);
        when(executions.findById("900")).thenReturn(Optional.of(root()));
        Execution finished = child("1234", ExecutionState.COMPLETED);
        finished.setAiMessage(AiMessageEntity.builder().text(text).thinking("只有思考").build());

        new SubAgentCompleteNotifier(provider, emails).notifyCommander(finished);

        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(emails).sendMailOnce(eq(7L), content.capture(), any(), any());
        assertTrue(content.getValue().endsWith("本次执行未产生最终答复。"));
        assertFalse(content.getValue().contains("只有思考"));
    }

    @Test
    void absentAssistantMessageIsExplicit() {
        when(provider.getObject()).thenReturn(executions);
        when(executions.findById("900")).thenReturn(Optional.of(root()));

        new SubAgentCompleteNotifier(provider, emails).notifyCommander(child("1234", ExecutionState.CANCELLED));

        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(emails).sendMailOnce(eq(7L), content.capture(), any(), any());
        assertTrue(content.getValue().endsWith("本次执行未产生最终答复。"));
    }

    @ParameterizedTest
    @EnumSource(value = ExecutionState.class, names = {"FAILED", "CANCELLED"})
    void toolRoundTextIsNotForwardedAsFinalAnswer(ExecutionState state) {
        when(provider.getObject()).thenReturn(executions);
        when(executions.findById("900")).thenReturn(Optional.of(root()));
        Execution finished = child("1234", state);
        finished.setAiMessage(AiMessageEntity.builder().text("我先运行验收")
                .toolCalls(List.of(ToolCallRequest.builder().id("tool-1").name("验收工具").build())).build());

        new SubAgentCompleteNotifier(provider, emails).notifyCommander(finished);

        ArgumentCaptor<String> content = ArgumentCaptor.forClass(String.class);
        verify(emails).sendMailOnce(eq(7L), content.capture(), any(), any());
        assertTrue(content.getValue().endsWith("本次执行未产生最终答复。"));
        assertFalse(content.getValue().contains("我先运行验收"));
    }

    private static Execution root() {
        return Execution.builder().id("900").agentId("")
                .agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "800", ExecutionAttributes.AGENT_ID, "7"))
                        .build()).build()).build();
    }

    private static Execution child(String executionId, ExecutionState state) {
        return Execution.builder().id(executionId).agentId("").executionState(state)
                .agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "555", ExecutionAttributes.AGENT_ID, "8",
                                ExecutionAttributes.ROOT_SESSION_ID, "800", ExecutionAttributes.ROOT_EXECUTION_ID, "900",
                                ExecutionAttributes.TEAM_ID, "2")).build()).build()).build();
    }
}
