package com.summit.dp.toolcall.infrastructure.listener;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.sub_agent.result.SubAgentResultRenderer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.doAnswer;

/**
 * 委派回填回归：子执行终态后，父执行的 DELEGATION 槽位必须被写入子代理最终结果，
 * 且在父执行无其它 pending 槽位时恢复 —— 「挂起沿委派链传播」的另一半。
 *
 * <p>直调 {@code matchParentSlot} / {@code settle}（包私有测试缝），
 * 恢复走<b>真实</b>的 {@link ExecutionResumeCoordinator}：回填路径现在只登记恢复意图，
 * 真正跑 loop 的是协调器的异步 worker，因此断言必须等它跑完（latch），不能靠固定 sleep。</p>
 */
class DelegationBackfillListenerTest {

    private static final long PARENT_EXECUTION_ID = 1000L;
    private static final long ROOT_SESSION_ID = 800L;
    private static final long SUB_SESSION_ID = 555L;

    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ToolCallConverter converter = new ToolCallConverter(new ObjectMapper());
    private final SubAgentResultRenderer resultRenderer = mock(SubAgentResultRenderer.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SessionAttributeRestorer sessionAttributeRestorer = mock(SessionAttributeRestorer.class);
    private final TransactionTemplate transactions = mock(TransactionTemplate.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final List<ExecutionResumeCoordinator> coordinators = new CopyOnWriteArrayList<>();

    private final DelegationBackfillListener listener;

    DelegationBackfillListenerTest() {
        // 事务模板直通执行（单测无真事务）
        org.mockito.Mockito.doAnswer(invocation -> {
            java.util.function.Consumer<org.springframework.transaction.TransactionStatus> consumer =
                    invocation.getArgument(0);
            consumer.accept(null);
            return null;
        }).when(transactions).executeWithoutResult(any());

        SuspendedExecutionResumer resumer = new SuspendedExecutionResumer(toolCallRepository,
                sessionAttributeRestorer, modelContextService, controlProvider());
        DelegationSettleService settleService = new DelegationSettleService(toolCallRepository, converter,
                resultRenderer, modelContextService, transactions, resumeCoordinator(resumer));
        this.listener = new DelegationBackfillListener(toolCallRepository, converter,
                repositoryProvider(), settleService);
    }

    @AfterEach
    void shutdownCoordinators() {
        coordinators.forEach(ExecutionResumeCoordinator::close);
    }

    /**
     * 真实的恢复协调器 + 桩任务表：委派回填的断言是「父执行真的被恢复了」，
     * 用 mock 协调器只能验到 accept 被调，验不到恢复闸门与控制槽位那一步。
     */
    private ExecutionResumeCoordinator resumeCoordinator(SuspendedExecutionResumer resumer) {
        ExecutionResumeTaskRepository tasks = mock(ExecutionResumeTaskRepository.class);
        com.summit.dp.execution.domain.repository.ExecutionRepository executions =
                mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class);
        ExecutionResumeTask task = ExecutionResumeTask.builder().id(1L).executionId(PARENT_EXECUTION_ID)
                .generation(1L).state(ResumeTaskState.READY).attempts(0).version(1L)
                .nextAttemptAt(Instant.now()).createdAt(Instant.now()).updatedAt(Instant.now()).build();
        when(tasks.enqueue(anyLong(), anyLong(), any())).thenReturn(task);
        when(tasks.findByExecutionId(PARENT_EXECUTION_ID)).thenReturn(List.of(task));
        when(tasks.claim(any(), any())).thenReturn(true);
        when(tasks.updateState(any())).thenReturn(true);
        when(executions.findResumeGeneration(PARENT_EXECUTION_ID)).thenReturn(1L);
        when(executions.findSummariesByIds(any())).thenReturn(List.of(suspendedSummary()));
        ExecutionResumeCoordinator coordinator = new ExecutionResumeCoordinator(tasks, executions, resumer,
                repositoryProvider());
        coordinators.add(coordinator);
        return coordinator;
    }

    private com.summit.dp.execution.domain.model.Execution suspendedSummary() {
        com.summit.dp.execution.domain.model.Execution summary =
                new com.summit.dp.execution.domain.model.Execution();
        summary.setId(PARENT_EXECUTION_ID);
        summary.setSessionId(ROOT_SESSION_ID);
        summary.setStatus(ExecutionStatusCodes.SUSPENDED);
        summary.setResumeGeneration(1L);
        return summary;
    }

    @SuppressWarnings("unchecked")
    private ObjectProvider<ExecutionRepository> repositoryProvider() {
        ObjectProvider<ExecutionRepository> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(executionRepository);
        return provider;
    }


    @SuppressWarnings("unchecked")
    private ObjectProvider<ExecutionControl> controlProvider() {
        ObjectProvider<ExecutionControl> controlProvider = mock(ObjectProvider.class);
        when(controlProvider.getObject()).thenReturn(executionControl);
        return controlProvider;
    }

    // ------------------------------------------------------------------
    // 构桩
    // ------------------------------------------------------------------

    private Execution subExecution(ExecutionState state) {
        Map<String, Object> attributes = Map.of(
                ExecutionAttributes.ROOT_EXECUTION_ID, PARENT_EXECUTION_ID,
                ExecutionAttributes.SESSION_ID, String.valueOf(SUB_SESSION_ID));
        AgentRequest request = AgentRequest.builder().executionId("2000")
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                .build();
        Execution execution = mock(Execution.class);
        when(execution.getId()).thenReturn("2000");
        when(execution.getExecutionState()).thenReturn(state);
        when(execution.getAgentRequest()).thenReturn(request);
        return execution;
    }

    private Execution suspendedParentWithSlot() {
        ToolMessageEntity placeholder = ToolMessageEntity.builder()
                .id("call-1").name("call_sub_agent").text("子代理已暂停，等待人工审批").build();
        return parentExecution(ExecutionState.SUSPENDED, new ArrayList<>(List.of(placeholder)));
    }

    private Execution parentExecution(ExecutionState state, List<ToolMessageEntity> messages) {
        Map<String, Object> attributes = Map.of(
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        AgentRequest request = AgentRequest.builder().executionId(String.valueOf(PARENT_EXECUTION_ID))
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                .build();
        Execution execution = mock(Execution.class);
        when(execution.getId()).thenReturn(String.valueOf(PARENT_EXECUTION_ID));
        when(execution.getExecutionState()).thenReturn(state);
        when(execution.getAgentRequest()).thenReturn(request);
        // getMessages 的静态类型是 List<Message>，doReturn 绕开泛型协变检查
        org.mockito.Mockito.doReturn(messages).when(execution).getMessages();
        return execution;
    }

    private ToolCall pendingSlot() {
        return ToolCall.builder()
                .id("call-1").conversationId(ROOT_SESSION_ID).executionId(PARENT_EXECUTION_ID)
                .toolName("call_sub_agent").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("架构师").content(converter.delegationContent(String.valueOf(SUB_SESSION_ID), "评估方案"))
                .build();
    }

    // ------------------------------------------------------------------
    // 用例
    // ------------------------------------------------------------------

    @Test
    @DisplayName("子执行完成：槽位写入最终结果、卡片收口、父执行恢复")
    void backfillsSlotAndResumesParent() throws Exception {
        Execution sub = subExecution(ExecutionState.COMPLETED);
        when(resultRenderer.render(sub)).thenReturn("最终结果：方案是 A");
        Execution parent = suspendedParentWithSlot();
        ToolCall slot = pendingSlot();
        when(executionRepository.findById(String.valueOf(PARENT_EXECUTION_ID))).thenReturn(Optional.of(parent));
        // 第一次查（匹配槽位）见到本槽位；回填收口后第二次查（恢复前）已无 pending
        when(toolCallRepository.listUnresolvedByExecutionId(PARENT_EXECUTION_ID))
                .thenReturn(List.of(slot)).thenReturn(List.of());
        when(toolCallRepository.findById("call-1")).thenReturn(Optional.of(slot));
        CountDownLatch resumed = new CountDownLatch(1);
        doAnswer(invocation -> { resumed.countDown(); return parent; }).when(executionControl).resume(parent);

        DelegationBackfillListener.BackfillTarget target = listener.matchParentSlot(sub);
        listener.settle(target);

        // 槽位文本被真实结果覆盖
        assertEquals("最终结果：方案是 A", parent.getMessages().get(0).text());
        // 卡片结论 SUCCEEDED
        ArgumentCaptor<ToolCall> row = ArgumentCaptor.forClass(ToolCall.class);
        verify(toolCallRepository).updateById(row.capture());
        assertTrue(row.getValue().getRawOutput().contains("SUCCEEDED"));
        // 父上下文与恢复：恢复由协调器异步派发，必须等它真的跑完。
        // 上下文写两次是刻意的 —— 落定事务先写一次让回填结论立即可见，
        // 恢复 worker 再写一次把 loop 跑完后的最新消息集同步进模型上下文。
        assertTrue(resumed.await(5, TimeUnit.SECONDS), "协调器应派发恢复并让 loop 继续");
        verify(modelContextService, times(2)).replace(eq(ROOT_SESSION_ID), any());
        verify(sessionAttributeRestorer).restore(parent, ROOT_SESSION_ID);
    }

    @Test
    void childFinishingBeforeParentSuspendsIsReconciledAfterParentExits() throws Exception {
        Execution child = subExecution(ExecutionState.COMPLETED);
        Execution parent = suspendedParentWithSlot();
        when(parent.getExecutionState()).thenReturn(ExecutionState.RUNNING);
        ToolCall slot = pendingSlot().toBuilder().status(ToolCallStatus.PREPARING)
                .content(converter.delegationContent(String.valueOf(SUB_SESSION_ID), child.getId(), "任务")).build();
        when(toolCallRepository.findById("call-1")).thenReturn(Optional.of(slot));
        when(toolCallRepository.listUnresolvedByExecutionId(PARENT_EXECUTION_ID))
                .thenReturn(List.of(slot)).thenReturn(List.of(slot)).thenReturn(List.of());
        when(executionRepository.findById(String.valueOf(PARENT_EXECUTION_ID))).thenReturn(Optional.of(parent));
        when(executionRepository.findById(child.getId())).thenReturn(Optional.of(child));
        when(resultRenderer.render(child)).thenReturn("对应子执行的结果");
        CountDownLatch resumed = new CountDownLatch(1);
        doAnswer(invocation -> { resumed.countDown(); return parent; }).when(executionControl).resume(parent);

        listener.settle(listener.matchParentSlot(child));
        assertEquals(ToolCallStatus.PREPARING, slot.getStatus());
        verify(executionControl, never()).resume(any(Execution.class));
        when(parent.getExecutionState()).thenReturn(ExecutionState.SUSPENDED);
        listener.onExecutionSuspended(String.valueOf(PARENT_EXECUTION_ID), null);
        assertTrue(resumed.await(5, TimeUnit.SECONDS));
        assertTrue(slot.isCompleted());
        assertEquals("对应子执行的结果", parent.getMessages().getFirst().text());
    }

    @Test
    @DisplayName("父执行还有其它 pending 委派：先不恢复，等全部落定")
    void holdsResumeWhileOtherSlotsPending() {
        Execution sub = subExecution(ExecutionState.COMPLETED);
        when(resultRenderer.render(sub)).thenReturn("结果A");
        Execution parent = suspendedParentWithSlot();
        ToolCall slot = pendingSlot();
        ToolCall other = ToolCall.builder().id("call-2").conversationId(ROOT_SESSION_ID)
                .executionId(PARENT_EXECUTION_ID).toolName("call_sub_agent").type(ToolCallType.PROMISE)
                .status(ToolCallStatus.PENDING)
                .content(converter.delegationContent("777", "另一件事")).build();
        when(executionRepository.findById(String.valueOf(PARENT_EXECUTION_ID))).thenReturn(Optional.of(parent));
        // 第一次查（匹配槽位）看到两个 pending；第二次查（恢复前）只剩另一个
        when(toolCallRepository.listUnresolvedByExecutionId(PARENT_EXECUTION_ID))
                .thenReturn(List.of(slot, other)).thenReturn(List.of(other));
        when(toolCallRepository.findById("call-1")).thenReturn(Optional.of(slot));

        listener.settle(listener.matchParentSlot(sub));

        verify(executionControl, never()).resume(any(Execution.class));
        assertTrue(slot.isCompleted(), "本槽位照常收口");
    }

    @Test
    @DisplayName("父执行已被取消（随停止收尾）：只收口卡片，不恢复")
    void skipsResumeWhenParentCancelled() {
        Execution sub = subExecution(ExecutionState.CANCELLED);
        when(resultRenderer.render(sub)).thenReturn("子代理执行已被取消");
        Execution parent = parentExecution(ExecutionState.CANCELLED, new ArrayList<>(List.of(
                ToolMessageEntity.builder().id("call-1").name("call_sub_agent").text("占位").build())));
        ToolCall slot = pendingSlot();
        when(executionRepository.findById(String.valueOf(PARENT_EXECUTION_ID))).thenReturn(Optional.of(parent));
        when(toolCallRepository.listUnresolvedByExecutionId(PARENT_EXECUTION_ID))
                .thenReturn(List.of(slot)).thenReturn(List.of());
        when(toolCallRepository.findById("call-1")).thenReturn(Optional.of(slot));

        listener.settle(listener.matchParentSlot(sub));

        verify(executionControl, never()).resume(any(Execution.class));
        assertTrue(slot.isCompleted());
    }

    @Test
    @DisplayName("子执行被单独取消（父仍挂起）：回填取消文案并恢复父执行，父不悬挂")
    void resumesParentWithCancellationNoticeWhenSubCancelledAlone() throws Exception {
        // 场景：用户只停止/取消了子会话（suspend(subSessionId) / cancel 单独命中子执行），
        // 父执行的槽位不能永远悬空 —— 回填取消说明，交还父模型自行决策（重派或收尾）。
        Execution sub = subExecution(ExecutionState.CANCELLED);
        when(resultRenderer.render(sub)).thenReturn("子代理执行已被取消（用户已停止），无结果: 评估方案");
        Execution parent = suspendedParentWithSlot();
        ToolCall slot = pendingSlot();
        when(executionRepository.findById(String.valueOf(PARENT_EXECUTION_ID))).thenReturn(Optional.of(parent));
        when(toolCallRepository.listUnresolvedByExecutionId(PARENT_EXECUTION_ID))
                .thenReturn(List.of(slot)).thenReturn(List.of());
        when(toolCallRepository.findById("call-1")).thenReturn(Optional.of(slot));
        CountDownLatch resumed = new CountDownLatch(1);
        doAnswer(invocation -> { resumed.countDown(); return parent; }).when(executionControl).resume(parent);

        listener.settle(listener.matchParentSlot(sub));

        assertEquals("子代理执行已被取消（用户已停止），无结果: 评估方案",
                parent.getMessages().get(0).text(), "父模型看到的是取消说明而非暂停占位");
        assertTrue(slot.getRawOutput().contains("CANCELLED"), "卡片结论为取消");
        assertTrue(resumed.await(5, TimeUnit.SECONDS), "父执行不应悬挂：取消说明回填后必须恢复");
    }

    @Test
    @DisplayName("主执行终结（无 ROOT_EXECUTION_ID）：不产生任何回填动作")
    void ignoresRootExecution() {
        assertNull(listener.matchParentSlot(rootExecution()));
        verify(toolCallRepository, never()).listUnresolvedByExecutionId(anyLong());
    }

    private Execution rootExecution() {
        Map<String, Object> attributes = Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        AgentRequest request = AgentRequest.builder().executionId(String.valueOf(PARENT_EXECUTION_ID))
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build()).build();
        Execution execution = mock(Execution.class);
        when(execution.getAgentRequest()).thenReturn(request);
        return execution;
    }

    @Test
    @DisplayName("旧格式数据（父侧无 DELEGATION 槽位）：自然短路，保持旧行为")
    void ignoresLegacySuspensionWithoutSlot() {
        ToolCall legacy = ToolCall.builder().id("call-9").conversationId(ROOT_SESSION_ID)
                .executionId(PARENT_EXECUTION_ID).toolName("require_choice").type(ToolCallType.PROMISE)
                .status(ToolCallStatus.PENDING).content("{\"kind\":\"CHOICE\"}").build();
        when(toolCallRepository.listUnresolvedByExecutionId(PARENT_EXECUTION_ID)).thenReturn(List.of(legacy));

        assertNull(listener.matchParentSlot(subExecution(ExecutionState.COMPLETED)));
    }
}
