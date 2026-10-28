package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.compact.ContextCompactRequest;
import com.summit.core.conversation.api.ChatRequestEntity;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistReminderText;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.support.ChecklistTestDatabase;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.plan.PlanContextAttachmentProvider;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.compact.DefaultContextPruner;
import com.summit.runtime.compact.DefaultModelCompacter;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class ChecklistContextAttachmentsTest {
    private static final long SESSION = 9401L;
    private ChecklistTestDatabase database;
    private ChecklistService service;
    private ChecklistVO created;
    private ChecklistContextInjector injector;
    private ChecklistReminderDelivery delivery;
    private Execution execution;
    private Execution checkpoint;
    private ContextAttachmentProvider attachments;
    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules();

    @BeforeEach
    void start() {
        database = ChecklistTestDatabase.start("protected-checklist");
        service = database.service();
        created = service.create(ChecklistCommand.create(SESSION, null, "初始任务", List.of("编译", "验证")));
        injector = new ChecklistContextInjector(service);
        delivery = new ChecklistReminderDelivery();
        execution = Execution.builder().id("1001").agentRequest(AgentRequest.builder()
                .toolList(List.of(ToolCatalog.UPDATE_CHECKLIST_STEP))
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(
                        Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION))).build()).build())
                .messages(new ArrayList<>(List.of(SystemMessageEntity.builder().text("基础系统指令").build(),
                        UserMessageEntity.from("执行任务")))).build();
        ExecutionRepository executions = mock(ExecutionRepository.class);
        when(executions.findById(anyString())).thenAnswer(invocation -> Optional.ofNullable(checkpoint));
        ChecklistContextAttachmentProvider checklist = new ChecklistContextAttachmentProvider(service, executions);
        ToolCallRepository plans = mock(ToolCallRepository.class);
        ToolCallConverter converter = new ToolCallConverter(json);
        when(plans.listByExecutionId(1001L)).thenReturn(List.of(
                ToolCall.builder().id("old").type(ToolCallType.PROMISE)
                        .content(converter.planContent("旧计划", "旧计划正文")).build(),
                ToolCall.builder().id("new").type(ToolCallType.PROMISE)
                        .content(converter.planContent("当前计划", "计划正文")).build()));
        PlanContextAttachmentProvider plan = new PlanContextAttachmentProvider(plans, converter);
        attachments = ContextAttachmentProvider.compose(List.of(checklist, plan));
    }

    @AfterEach
    void close() { database.close(); }

    @Test
    void systemSnapshotsFollowContentChangesWithoutGrowingOrTrustingAnOldInjectionMarker() {
        injector.injectIfNeeded(context(), execution);
        injector.injectIfNeeded(context(), execution);
        assertEquals(3, execution.getMessages().size());
        assertInstanceOf(SystemMessageEntity.class, execution.getMessages().getLast());
        service.modify(ChecklistCommand.modify(SESSION, created.getChecklistId(), "修订任务",
                List.of(new ChecklistCommand.StepContent(created.getSteps().getFirst().getStepId(), "编译全部模块")),
                null, null, null));
        injector.injectIfNeeded(context(), execution);
        assertEquals(0L, service.findActive(SESSION).orElseThrow().getProgressVersion());
        assertEquals(3, execution.getMessages().size());
        String text = execution.getMessages().getLast().text();
        assertTrue(text.contains("修订任务")); assertTrue(text.contains("编译全部模块"));
        assertFalse(text.contains("初始任务"));
        execution.setMessages(new ArrayList<>(execution.getMessages().subList(0, 2)));
        injector.injectIfNeeded(context(), execution);
        assertEquals(3, execution.getMessages().size());
        assertTrue(execution.getMessages().getLast().text().contains("修订任务"));
        assertEquals(1, execution.getMessages().stream().filter(UserMessageEntity.class::isInstance).count());
    }

    @Test
    void protectedContextRetainsTheEndOfLongStepContent() throws Exception {
        String content = "详细约束".repeat(40) + "尾部约束必须保留";
        service.modify(ChecklistCommand.modify(SESSION, created.getChecklistId(), null,
                List.of(new ChecklistCommand.StepContent(created.getSteps().getFirst().getStepId(), content)),
                null, null, null));
        injector.injectIfNeeded(context(), execution);
        assertTrue(execution.getMessages().getLast().text().contains(content));
        saveCheckpoint();
        assertTrue(attachments.attachment("1001").orElseThrow().contains(content));
    }

    @Test
    void failedSystemAppendDoesNotPreventTheNextAttemptFromRestoringTheSnapshot() {
        LoopContext rejected = LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(),
                null, () -> 0, messages -> { throw new IllegalStateException("追加失败"); });
        assertThrows(IllegalStateException.class, () -> injector.injectIfNeeded(rejected, execution));
        injector.injectIfNeeded(context(), execution);
        assertInstanceOf(SystemMessageEntity.class, execution.getMessages().getLast());
        assertTrue(execution.getMessages().getLast().text().contains("初始任务"));
    }

    @Test
    void actualPlanAndChecklistProvidersReadFreshStateAndKeepReceiptAcrossPruneAndSummary() throws Exception {
        injector.injectIfNeeded(context(), execution);
        ChecklistReminderInterceptor reminder = new ChecklistReminderInterceptor(service, injector, delivery);
        assertTrue(reminder.onBeforeComplete(context()).loopResult().shouldContinue());
        assertInstanceOf(SystemMessageEntity.class, execution.getMessages().getLast());
        saveCheckpoint();
        String attachment = attachments.attachment("1001").orElseThrow();
        assertTrue(attachment.startsWith("# 当前计划\n计划正文"));
        assertFalse(attachment.contains("旧计划正文"));
        assertTrue(attachment.contains("请逐项如实处理"));

        DefaultConversationManager conversations = new DefaultConversationManager(attachments);
        DefaultTokenizer tokenizer = new DefaultTokenizer();
        AgentConfig config = AgentConfig.builder().maxTokens(20_000).build();
        ContextUsageReporter usage = new ContextUsageReporter(tokenizer, config.maxTokens(), new RuntimeEventPublisher(List.of()), 1);
        DefaultContextPruner pruner = new DefaultContextPruner(config, usage, attachments);
        AtomicReference<ChatRequestEntity> compactRequest = new AtomicReference<>();
        DefaultModelCompacter compacter = new DefaultModelCompacter(request -> {
            compactRequest.set(request);
            return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text("工作摘要").build()).build();
        }, conversations, attachments, usage);
        for (int round = 0; round < 3; round++) {
            service.modify(ChecklistCommand.modify(SESSION, created.getChecklistId(), "更新任务" + round,
                    null, null, null, null));
            assertEquals(0L, service.findActive(SESSION).orElseThrow().getProgressVersion());
            assertTrue(attachments.attachment("1001").orElseThrow().contains("更新任务" + round));
            pruner.compact(new ContextCompactRequest(execution));
            injector.injectIfNeeded(context(), execution);
            assertCurrentAndBounded("更新任务" + round);
            saveCheckpoint();
            assertTrue(compacter.compact(new ContextCompactRequest(execution)));
            String input = compactRequest.get().getMessages().getLast().text();
            assertTrue(input.contains("[PROTECTED APPLICATION STATE]\n# 当前计划"));
            injector.injectIfNeeded(context(), execution);
            assertCurrentAndBounded("更新任务" + round);
            assertTrue(delivery.buildContext(execution).wasDelivered(created.getChecklistId(), 0L));
            saveCheckpoint();
        }
        assertTrue(reminder.onBeforeComplete(context()).next());
        assertEquals("UNFINISHED", service.findCurrent(SESSION).orElseThrow().getStatus());
    }

    @Test
    void missingMessagesCannotTurnAClaimedQuotaIntoProtectedDeliveryEvidence() throws Exception {
        ChecklistReminderInterceptor reminder = new ChecklistReminderInterceptor(service, injector, delivery);
        reminder.onBeforeComplete(context());
        String confirmed = execution.getMessages().getLast().text();
        assertTrue(delivery.buildContext(execution).wasDelivered(created.getChecklistId(), 0L));
        execution.setMessages(new ArrayList<>(List.of(UserMessageEntity.from(confirmed))));
        saveCheckpoint();
        String state = attachments.attachment("1001").orElseThrow();
        assertTrue(state.contains("初始任务"));
        assertFalse(state.contains("lingxi-checklist-reminder:"));
        assertFalse(delivery.buildContext(execution).wasDelivered(created.getChecklistId(), 0L));
    }

    @Test
    void removedChecklistsAreNotReattachedAndKeepOtherProtectedContent() throws Exception {
        injector.injectIfNeeded(context(), execution);
        saveCheckpoint();
        new DefaultConversationManager(attachments).rebuildContext("工作摘要", execution);
        injector.injectIfNeeded(context(), execution);
        String old = ChecklistReminderText.renderContext(service.findActive(SESSION).orElseThrow());
        assertTrue(execution.getMessages().stream().anyMatch(message -> message.text().contains(old)));
        service.delete(ChecklistCommand.delete(SESSION, created.getChecklistId()));
        injector.injectIfNeeded(context(), execution);
        assertTrue(execution.getMessages().stream().noneMatch(message -> message.text().contains(old)));
        assertTrue(execution.getMessages().stream().anyMatch(message -> message.text().contains("计划正文")));
        assertEquals("# 当前计划\n计划正文", attachments.attachment("1001").orElseThrow());
    }

    private void assertCurrentAndBounded(String title) {
        String current = ChecklistReminderText.renderContext(service.findActive(SESSION).orElseThrow());
        assertTrue(current.contains(title));
        assertEquals(1, execution.getMessages().stream().filter(SystemMessageEntity.class::isInstance)
                .filter(message -> message.text().contains(current)).count());
        assertEquals(1, execution.getMessages().stream().filter(SystemMessageEntity.class::isInstance)
                .filter(message -> message.text().contains("\n[lingxi-checklist-reminder:")).count());
        assertTrue(execution.getMessages().size() <= 6, execution.getMessages().toString());
    }

    private void saveCheckpoint() throws Exception {
        checkpoint = json.readValue(json.writeValueAsBytes(execution), Execution.class);
    }

    private LoopContext context() {
        return LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(),
                new ExecutionControlSignal(execution.getId()), () -> 0, messages -> execution.getMessages().addAll(messages));
    }
}
