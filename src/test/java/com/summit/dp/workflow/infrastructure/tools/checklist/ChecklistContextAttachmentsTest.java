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
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.runtime.loop.*;
import com.summit.dp.checklist.application.*;
import com.summit.dp.checklist.support.ChecklistTestDatabase;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.plan.PlanContextAttachmentProvider;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.compact.DefaultCompactSummaryApplier;
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
    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules();

    @BeforeEach
    void start() {
        database = ChecklistTestDatabase.start("protected-checklist");
        service = database.service();
        created = service.create(ChecklistCommand.create(SESSION, null, "初始任务", List.of("编译", "验证")));
        injector = new ChecklistContextInjector(service);
        delivery = new ChecklistReminderDelivery(executions);
        execution = Execution.builder().id("1001").agentRequest(AgentRequest.builder()
                .toolSpec(com.summit.core.agent.ToolSpec.builder().toolList(List.of(ToolCatalog.UPDATE_CHECKLIST_STEP)).build())
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(
                        Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION))).build()).build())
                .messages(new ArrayList<>(List.of(SystemMessageEntity.builder().text("基础系统指令").build(),
                        UserMessageEntity.from("执行任务")))).build();
        doAnswer(invocation -> {
            Execution saved = invocation.getArgument(0);
            checkpoint = json.readValue(json.writeValueAsBytes(saved), Execution.class);
            return null;
        }).when(executions).save(any());
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
    void reminderPersistsItsReceiptWithoutAnAutomaticRoundCheckpoint() throws Exception {
        saveCheckpoint();
        ReminderDecision decision = service.remindOnNaturalComplete(delivery.buildContext(execution));

        delivery.append(context(), decision);

        verify(executions).save(execution);
        assertNotSame(execution, checkpoint);
        String marker = (String) checkpoint.getAgentRequest().runtimeParametersOrDefault().getAttributes()
                .get(ChecklistReminderState.DELIVERED_MARKER);
        assertNotNull(marker, "投递成功后必须立即保存证据，不能依赖下一轮快照");
        assertTrue(checkpoint.getMessages().stream().anyMatch(message -> message.text().contains(marker)));

        execution.getMessages().removeIf(message -> message.text().contains(marker));
        new DefaultConversationManager(attachments).rebuildContext("工作摘要", execution);
        assertTrue(execution.getMessages().stream().anyMatch(message -> message.text().contains(marker)));
    }

    @Test
    void reminderCheckpointFailurePropagatesBeforeAnotherModelRound() {
        IllegalStateException failure = new IllegalStateException("保存提醒检查点失败");
        doThrow(failure).when(executions).save(any());
        ChecklistReminderInterceptor reminder = new ChecklistReminderInterceptor(service, injector, delivery);

        assertSame(failure, assertThrows(IllegalStateException.class, () -> reminder.onBeforeComplete(context())));
        assertFalse(reminder.catchErr());
    }

    @Test
    void aRejectedReminderAppendCannotPublishCheckpointEvidence() {
        ReminderDecision decision = service.remindOnNaturalComplete(delivery.buildContext(execution));
        LoopContext rejected = LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(), null, () -> 0, null, messages -> { throw new IllegalStateException("追加提醒失败"); });

        assertThrows(IllegalStateException.class, () -> delivery.append(rejected, decision));
        verify(executions, never()).save(any());
        assertFalse(execution.getAgentRequest().runtimeParametersOrDefault().getAttributes()
                .containsKey(ChecklistReminderState.DELIVERED_MARKER));
    }

    @Test
    void updateNoticesAppendOnlyWhenTheVersionOrTheTitleChangesOrTheMessageIsGone() {
        injector.injectIfNeeded(context(), execution);
        injector.injectIfNeeded(context(), execution);
        assertEquals(3, execution.getMessages().size());
        assertInstanceOf(UserMessageEntity.class, execution.getMessages().getLast(),
                "清单通知按用户消息下发，后续轮次不再改写它");
        assertTrue(execution.getMessages().getLast().text().contains("初始任务"));

        service.modify(ChecklistCommand.modify(SESSION, created.getChecklistId(), "修订任务",
                List.of(new ChecklistCommand.StepContent(created.getSteps().getFirst().getStepId(), "编译全部模块")),
                null, null, null));
        injector.injectIfNeeded(context(), execution);
        assertEquals(0L, service.findActive(SESSION).orElseThrow().getProgressVersion());
        assertEquals(4, execution.getMessages().size(), "标题变了就追加新通知，绝不改写历史那条");
        String text = execution.getMessages().getLast().text();
        assertTrue(text.contains("修订任务"));
        assertFalse(text.contains("编译全部模块"), "通知不复制步骤正文");

        execution.setMessages(new ArrayList<>(execution.getMessages().subList(0, 2)));
        injector.injectIfNeeded(context(), execution);
        assertEquals(3, execution.getMessages().size(), "消息被压缩带走后必须补回一条");
        assertTrue(execution.getMessages().getLast().text().contains("修订任务"));
        assertEquals(2, execution.getMessages().stream().filter(UserMessageEntity.class::isInstance).count(),
                "补回的是通知，用户原话不动");
    }

    @Test
    void protectedContextRetainsTheEndOfLongStepContent() throws Exception {
        String content = "详细约束".repeat(40) + "尾部约束必须保留";
        service.modify(ChecklistCommand.modify(SESSION, created.getChecklistId(), null,
                List.of(new ChecklistCommand.StepContent(created.getSteps().getFirst().getStepId(), content)),
                null, null, null));
        injector.injectIfNeeded(context(), execution);
        assertFalse(execution.getMessages().getLast().text().contains(content),
                "长正文不进每轮通知，否则同一份快照会被反复计费");
        saveCheckpoint();
        assertTrue(attachments.attachment("1001").orElseThrow().contains(content));
    }

    @Test
    void failedAppendDoesNotPreventTheNextAttemptFromRestoringTheNotice() {
        LoopContext rejected = LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(), null, () -> 0, null, messages -> { throw new IllegalStateException("追加失败"); });
        assertThrows(IllegalStateException.class, () -> injector.injectIfNeeded(rejected, execution));
        injector.injectIfNeeded(context(), execution);
        assertInstanceOf(UserMessageEntity.class, execution.getMessages().getLast());
        assertTrue(execution.getMessages().getLast().text().contains("初始任务"));
    }

    @Test
    void actualPlanAndChecklistProvidersReadFreshStateAndKeepReceiptAcrossPruneAndSummary() throws Exception {
        injector.injectIfNeeded(context(), execution);
        ChecklistReminderInterceptor reminder = new ChecklistReminderInterceptor(service, injector, delivery);
        assertTrue(reminder.onBeforeComplete(context()).loopResult().shouldContinue());
        assertInstanceOf(UserMessageEntity.class, execution.getMessages().getLast(),
                "收尾提醒也按用户消息追加，压缩会保留它");
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
        ChatModel summaryModel = request -> {
            compactRequest.set(request);
            return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text("工作摘要").build()).build();
        };
        DefaultModelCompacter compacter = DefaultModelCompacter.builder()
                .models(request -> summaryModel)
                .conversationManager(conversations)
                .contextAttachmentProvider(attachments)
                .usage(usage)
                .summaryApplier(new DefaultCompactSummaryApplier(conversations))
                .build();
        for (int round = 0; round < 3; round++) {
            service.modify(ChecklistCommand.modify(SESSION, created.getChecklistId(), "更新任务" + round,
                    null, null, null, null));
            assertEquals(0L, service.findActive(SESSION).orElseThrow().getProgressVersion());
            assertTrue(attachments.attachment("1001").orElseThrow().contains("更新任务" + round));
            pruner.compact(new ContextCompactRequest(execution));
            injector.injectIfNeeded(context(), execution);
            assertLatestNoticeBounded("更新任务" + round);
            saveCheckpoint();
            assertTrue(compacter.compact(new ContextCompactRequest(execution)));
            String input = compactRequest.get().getMessages().getLast().text();
            assertTrue(input.contains("[PROTECTED APPLICATION STATE]\n# 当前计划"));
            injector.injectIfNeeded(context(), execution);
            assertLatestNoticeBounded("更新任务" + round);
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
        assertTrue(delivery.buildContext(execution).wasDelivered(created.getChecklistId(), 0L));
        execution.setMessages(new ArrayList<>());
        saveCheckpoint();
        String state = attachments.attachment("1001").orElseThrow();
        assertTrue(state.contains("初始任务"));
        assertFalse(state.contains("lingxi-checklist-reminder:"));
        assertFalse(delivery.buildContext(execution).wasDelivered(created.getChecklistId(), 0L));
    }

    @Test
    void removedChecklistsStopAppendingWithoutRewritingWhatWasAlreadySent() throws Exception {
        injector.injectIfNeeded(context(), execution);
        saveCheckpoint();
        new DefaultConversationManager(attachments).rebuildContext("工作摘要", execution);
        injector.injectIfNeeded(context(), execution);
        String notice = ChecklistReminderText.renderUpdate(service.findActive(SESSION).orElseThrow());
        assertTrue(execution.getMessages().stream().anyMatch(message -> message.text().equals(notice)));
        int before = execution.getMessages().size();
        service.delete(ChecklistCommand.delete(SESSION, created.getChecklistId()));
        injector.injectIfNeeded(context(), execution);
        assertEquals(before, execution.getMessages().size(), "清单删除不再新增通知，历史消息原样保留");
        assertTrue(execution.getMessages().stream().anyMatch(message -> message.text().contains("计划正文")));
        assertEquals("# 当前计划\n计划正文", attachments.attachment("1001").orElseThrow());
    }

    @Test
    void checklistUserMessagesCarryCompactionMarkerAndDoNotPileUpAcrossCompactions() throws Exception {
        injector.injectIfNeeded(context(), execution);
        UserMessageEntity firstNotice = assertInstanceOf(UserMessageEntity.class, execution.getMessages().getLast());
        assertTrue(firstNotice.hasCompactionMarker(), "清单通知必须带压缩标记，避免被当成真实用户发言");

        ChecklistReminderInterceptor reminder = new ChecklistReminderInterceptor(service, injector, delivery);
        assertTrue(reminder.onBeforeComplete(context()).loopResult().shouldContinue());
        UserMessageEntity reminderMessage = assertInstanceOf(UserMessageEntity.class, execution.getMessages().getLast());
        assertTrue(reminderMessage.hasCompactionMarker(), "收尾提醒必须带压缩标记");

        execution.getMessages().add(AiMessageEntity.builder().text("收到，继续推进").build());
        execution.getMessages().add(UserMessageEntity.from("下一轮用户提问"));
        saveCheckpoint();

        DefaultConversationManager conversations = new DefaultConversationManager(attachments);
        conversations.rebuildContext("第一次摘要", execution);
        assertTrue(execution.getMessages().stream().anyMatch(message -> message.text().equals(firstNotice.text())),
                "首次压缩保留一轮以便衔接");

        execution.getMessages().add(AiMessageEntity.builder().text("继续处理").build());
        execution.getMessages().add(UserMessageEntity.from("再下一轮用户提问"));
        conversations.rebuildContext("第二次摘要", execution);
        assertFalse(execution.getMessages().stream().anyMatch(message -> message.text().equals(firstNotice.text())),
                "已有后续回复且经过两次压缩的旧清单通知必须淘汰，不能永久堆叠在 earlierUsers");
    }

    /** 通知只保留最近一份，且不复制步骤正文：每轮追加正文会把同一份快照反复计费。 */
    private void assertLatestNoticeBounded(String title) {
        String current = ChecklistReminderText.renderUpdate(service.findActive(SESSION).orElseThrow());
        assertTrue(current.contains(title));
        assertEquals(1, execution.getMessages().stream().filter(UserMessageEntity.class::isInstance)
                .filter(message -> message.text().equals(current)).count(), "同一版本的通知只留一条");
        assertTrue(execution.getMessages().size() <= 12, execution.getMessages().toString());
    }

    private void saveCheckpoint() throws Exception {
        checkpoint = json.readValue(json.writeValueAsBytes(execution), Execution.class);
    }

    private LoopContext context() {
        return LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(), new ExecutionControlSignal(execution.getId()), () -> 0, null, messages -> execution.getMessages().addAll(messages));
    }
}
