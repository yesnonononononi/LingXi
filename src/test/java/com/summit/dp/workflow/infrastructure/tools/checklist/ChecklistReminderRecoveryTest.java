package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistReminderContext;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.domain.model.Checklist;
import com.summit.dp.checklist.domain.model.ChecklistStatus;
import com.summit.dp.checklist.infrastructure.repository.ChecklistRepositoryImpl;
import com.summit.dp.checklist.support.ChecklistTestDatabase;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.when;

class ChecklistReminderRecoveryTest {
    private static final long SESSION = 6301L;
    private ChecklistTestDatabase fixture;
    private ChecklistService service;
    private ChecklistReminderInterceptor reminder;
    private ChecklistVO created;

    @BeforeEach
    void start() {
        fixture = ChecklistTestDatabase.start("reminder-recovery");
        service = fixture.service();
        reminder = new ChecklistReminderInterceptor(service, new ChecklistContextInjector(service), new ChecklistReminderDelivery());
        created = service.create(ChecklistCommand.create(SESSION, null, "恢复", List.of("一步", "两步")));
    }

    @AfterEach
    void close() { fixture.close(); }

    @Test
    void aNewExecutionReceivesItsOwnReminderBeforeClosing() {
        Execution first = execution("1001");
        reminder.onBeforeComplete(context(first));
        Execution next = execution("2002");

        assertFalse(reminder.onBeforeComplete(context(next)).next());
        assertEquals(ChecklistStatus.ACTIVE, reloaded().getStatus());
        assertEquals(2002L, reloaded().getRemindExecutionId());
        assertTrue(next.getMessages().getLast().text().contains(":2002]"));
        assertTrue(reminder.onBeforeComplete(context(next)).next());
        assertEquals(ChecklistStatus.UNFINISHED, reloaded().getStatus());
    }

    @Test
    void aSuspendedOwnerCannotBeTakenOver() {
        reminder.onBeforeComplete(context(execution("1001")));
        when(fixture.executionQueries().activeBySession(any())).thenReturn(List.of(
                new ExecutionQueryService.ActiveExecution(1001L, SESSION, "SUSPENDED", null, null)));

        assertThrows(ClientException.class, () -> reminder.onBeforeComplete(context(execution("2002"))));
        assertEquals(ChecklistStatus.ACTIVE, reloaded().getStatus());
        assertEquals(1001L, reloaded().getRemindExecutionId());
    }

    @Test
    void theCurrentRunningExecutionCanConsumeAndConfirmItsOwnReminder() {
        when(fixture.executionQueries().activeBySession(any())).thenReturn(List.of(
                new ExecutionQueryService.ActiveExecution(1001L, SESSION, "RUNNING", null, null)));
        Execution execution = execution("1001");

        assertFalse(reminder.onBeforeComplete(context(execution)).next());
        assertTrue(reminder.onBeforeComplete(context(execution)).next());
        assertEquals(ChecklistStatus.UNFINISHED, reloaded().getStatus());
    }

    @Test
    void injectionFailureIsReplayedBeforeANewExecutionCanClose() {
        Execution first = execution("1001");
        LoopContext failed = LoopContext.withCompactionCounter(LoopMessages.builder().execution(first).build(),
                new ExecutionControlSignal("1001"), () -> 0, messages -> { throw new IllegalStateException("注入失败"); });
        assertThrows(IllegalStateException.class, () -> reminder.onBeforeComplete(failed));
        assertTrue(reloaded().isRemindStatus());

        Execution retry = execution("2002");
        assertFalse(reminder.onBeforeComplete(context(retry)).next());
        assertEquals(ChecklistStatus.ACTIVE, reloaded().getStatus());
        assertEquals(2, retry.getMessages().size());
        assertTrue(reminder.onBeforeComplete(context(retry)).next());
        assertEquals(ChecklistStatus.UNFINISHED, reloaded().getStatus());
    }

    @Test
    void anAttributeWithoutItsMessageIsNotDeliveryEvidence() {
        Execution execution = execution("1001");
        reminder.onBeforeComplete(context(execution));
        execution.setMessages(new ArrayList<>());

        assertFalse(reminder.onBeforeComplete(context(execution)).next());
        assertEquals(1, execution.getMessages().size());
        assertEquals(ChecklistStatus.ACTIVE, reloaded().getStatus());
    }

    @Test
    void aMessageWithoutItsServerAttributeIsNotDeliveryEvidence() {
        Execution execution = execution("1001");
        reminder.onBeforeComplete(context(execution));
        execution.getAgentRequest().runtimeParametersOrDefault().setAttributes(
                Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION)));

        assertFalse(reminder.onBeforeComplete(context(execution)).next());
        assertEquals(ChecklistStatus.ACTIVE, reloaded().getStatus());
        assertEquals(3, execution.getMessages().size());
    }

    @Test
    void aRestoredCheckpointRetainsBothPartsOfTheReceipt() throws Exception {
        Execution execution = execution("1001");
        reminder.onBeforeComplete(context(execution));
        ObjectMapper json = new ObjectMapper().findAndRegisterModules();
        Execution restored = json.readValue(json.writeValueAsBytes(execution), Execution.class);

        assertTrue(reminder.onBeforeComplete(context(restored)).next());
        assertEquals(ChecklistStatus.UNFINISHED, reloaded().getStatus());
        assertEquals(2, restored.getMessages().size());
    }

    @Test
    void progressRequiresANewReceiptForTheNewVersion() {
        Execution execution = execution("1001");
        reminder.onBeforeComplete(context(execution));
        service.updateStep(ChecklistCommand.updateStep(SESSION, created.getChecklistId(),
                created.getSteps().getFirst().getStepId(), "COMPLETED"));

        assertFalse(reminder.onBeforeComplete(context(execution)).next());
        assertEquals(ChecklistStatus.ACTIVE, reloaded().getStatus());
        assertEquals(1L, reloaded().getRemindedProgressVersion());
        assertEquals(3, execution.getMessages().size());
    }

    @Test
    void aMissedCasDoesNotMeanReminderExhaustion() {
        ChecklistRepositoryImpl rejected = spy(fixture.repository());
        doReturn(false).when(rejected).claimReminder(any(Checklist.class), anyLong());
        ChecklistService rejectedService = fixture.serviceWithRepository(rejected);
        ChecklistReminderInterceptor rejectedReminder = new ChecklistReminderInterceptor(rejectedService,
                new ChecklistContextInjector(rejectedService), new ChecklistReminderDelivery());

        assertThrows(ClientException.class, () -> rejectedReminder.onBeforeComplete(context(execution("1001"))));
        assertFalse(reloaded().isRemindStatus());
        assertEquals(ChecklistStatus.ACTIVE, reloaded().getStatus());
    }

    @Test
    void ownerlessCurrentExecutionsCannotConsumeQuota() {
        assertThrows(ClientException.class, () -> service.remindOnNaturalComplete(
                new ChecklistReminderContext(SESSION, null, null)));
        assertFalse(reloaded().isRemindStatus());
    }

    private Checklist reloaded() {
        return fixture.repository().findByIdWithSteps(created.getChecklistId()).orElseThrow();
    }

    private Execution execution(String id) {
        List<Message> messages = new ArrayList<>(List.of(UserMessageEntity.from("继续")));
        return Execution.builder().id(id).messages(messages).agentRequest(AgentRequest.builder()
                .toolList(List.of(ToolCatalog.UPDATE_CHECKLIST_STEP))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION))).build())
                .build()).build();
    }

    private LoopContext context(Execution execution) {
        return LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(),
                new ExecutionControlSignal(execution.getId()), () -> 0, messages -> execution.getMessages().addAll(messages));
    }
}
