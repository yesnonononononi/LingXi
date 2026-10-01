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
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.sub_agent.result.SubAgentResultRenderer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 委派回填回归：子执行终态后，父执行的 DELEGATION 槽位必须被写入子代理最终结果，
 * 且在父执行无其它 pending 槽位时恢复 —— 「挂起沿委派链传播」的另一半。
 *
 * <p>直调 {@code matchParentSlot} / {@code settle}（包私有测试缝），绕开异步分发；
 * 异步只是线程选择，分支语义全部在这两个方法里。</p>
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

    private final DelegationBackfillListener listener;

    DelegationBackfillListenerTest() {
        @SuppressWarnings("unchecked")
        ObjectProvider<ExecutionRepository> repositoryProvider = mock(ObjectProvider.class);
        when(repositoryProvider.getObject()).thenReturn(executionRepository);
        @SuppressWarnings("unchecked")
        ObjectProvider<ExecutionControl> controlProvider = mock(ObjectProvider.class);
        when(controlProvider.getObject()).thenReturn(executionControl);
        // 事务模板直通执行（单测无真事务）
        org.mockito.Mockito.doAnswer(invocation -> {
            java.util.function.Consumer<org.springframework.transaction.TransactionStatus> consumer =
                    invocation.getArgument(0);
            consumer.accept(null);
            return null;
        }).when(transactions).executeWithoutResult(any());

        this.listener = new DelegationBackfillListener(toolCallRepository, converter, resultRenderer,
                modelContextService, sessionAttributeRestorer, transactions,
                repositoryProvider, controlProvider);
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
    void backfillsSlotAndResumesParent() {
        Execution sub = subExecution(ExecutionState.COMPLETED);
        when(resultRenderer.render(sub)).thenReturn("最终结果：方案是 A");
        Execution parent = suspendedParentWithSlot();
        ToolCall slot = pendingSlot();
        when(executionRepository.findById(String.valueOf(PARENT_EXECUTION_ID))).thenReturn(Optional.of(parent));
        // 第一次查（匹配槽位）见到本槽位；回填收口后第二次查（恢复前）已无 pending
        when(toolCallRepository.listPendingByExecutionId(PARENT_EXECUTION_ID))
                .thenReturn(List.of(slot)).thenReturn(List.of());
        when(toolCallRepository.findById("call-1")).thenReturn(Optional.of(slot));
        when(executionControl.resume(any(Execution.class))).thenReturn(parent);

        DelegationBackfillListener.BackfillTarget target = listener.matchParentSlot(sub);
        listener.settle(target);

        // 槽位文本被真实结果覆盖
        assertEquals("最终结果：方案是 A", parent.getMessages().get(0).text());
        // 卡片结论 SUCCEEDED
        ArgumentCaptor<ToolCall> row = ArgumentCaptor.forClass(ToolCall.class);
        verify(toolCallRepository).updateById(row.capture());
        assertTrue(row.getValue().getRawOutput().contains("SUCCEEDED"));
        // 父上下文与恢复
        verify(modelContextService).replace(eq(ROOT_SESSION_ID), any());
        verify(sessionAttributeRestorer).restore(parent, ROOT_SESSION_ID);
        verify(executionControl).resume(parent);
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
        when(toolCallRepository.listPendingByExecutionId(PARENT_EXECUTION_ID))
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
        when(toolCallRepository.listPendingByExecutionId(PARENT_EXECUTION_ID))
                .thenReturn(List.of(slot)).thenReturn(List.of());
        when(toolCallRepository.findById("call-1")).thenReturn(Optional.of(slot));

        listener.settle(listener.matchParentSlot(sub));

        verify(executionControl, never()).resume(any(Execution.class));
        assertTrue(slot.isCompleted());
    }

    @Test
    @DisplayName("子执行被单独取消（父仍挂起）：回填取消文案并恢复父执行，父不悬挂")
    void resumesParentWithCancellationNoticeWhenSubCancelledAlone() {
        // 场景：用户只停止/取消了子会话（suspend(subSessionId) / cancel 单独命中子执行），
        // 父执行的槽位不能永远悬空 —— 回填取消说明，交还父模型自行决策（重派或收尾）。
        Execution sub = subExecution(ExecutionState.CANCELLED);
        when(resultRenderer.render(sub)).thenReturn("子代理执行已被取消（用户已停止），无结果: 评估方案");
        Execution parent = suspendedParentWithSlot();
        ToolCall slot = pendingSlot();
        when(executionRepository.findById(String.valueOf(PARENT_EXECUTION_ID))).thenReturn(Optional.of(parent));
        when(toolCallRepository.listPendingByExecutionId(PARENT_EXECUTION_ID))
                .thenReturn(List.of(slot)).thenReturn(List.of());
        when(toolCallRepository.findById("call-1")).thenReturn(Optional.of(slot));
        when(executionControl.resume(any(Execution.class))).thenReturn(parent);

        listener.settle(listener.matchParentSlot(sub));

        assertEquals("子代理执行已被取消（用户已停止），无结果: 评估方案",
                parent.getMessages().get(0).text(), "父模型看到的是取消说明而非暂停占位");
        assertTrue(slot.getRawOutput().contains("CANCELLED"), "卡片结论为取消");
        verify(executionControl).resume(parent);
    }

    @Test
    @DisplayName("主执行终结（无 ROOT_EXECUTION_ID）：不产生任何回填动作")
    void ignoresRootExecution() {
        assertNull(listener.matchParentSlot(rootExecution()));
        verify(toolCallRepository, never()).listPendingByExecutionId(anyLong());
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
        when(toolCallRepository.listPendingByExecutionId(PARENT_EXECUTION_ID)).thenReturn(List.of(legacy));

        assertNull(listener.matchParentSlot(subExecution(ExecutionState.COMPLETED)));
    }
}
