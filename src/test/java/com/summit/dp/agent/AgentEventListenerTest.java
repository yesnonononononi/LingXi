package com.summit.dp.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.event.AgentPartialTextEvent;
import com.summit.core.conversation.event.ContextUpdateEvent;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.conversation.event.ExecutionStartEvent;
import com.summit.core.conversation.event.ExecutionSuspendedEvent;
import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.tool.ToolCallStatus;
import com.summit.dp.agent.infrastructure.listener.AgentEventListener;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.shared.event.SseEventPublisher;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

/**
 * 框架事件 → 根会话广播的唯一路径。
 *
 * <p>v3 直投与 v2 投影链路已移除，本测试验证三件事：<b>每个事件恰好做一次身份解析</b>、
 * <b>事件原样投递到根会话的桶</b>（序列化由 SSE 传输层负责，监听器不再自己拼 JSON），
 * 以及<b>终态事件照常广播、且会话流仍然连着</b>。</p>
 *
 * <p><b>「流仍然连着」断言的是结果而不是方法</b>：用真实 {@link SseEventPublisher} +
 * mock emitter 挂一条流，走完终态回调后断言 {@code connectedCount()} 没变。
 * 早先写的是 {@code verify(never()).disconnectRoot(...)} —— 那种写法守的是「某个方法没被调用」，
 * 方法一删就失效，且方法改名也会假绿；断言连接数才是契约本身。</p>
 */
class AgentEventListenerTest {
    private static final String EXECUTION_ID = "2105000000000000001";
    private static final long SESSION_ID = 2105000000000000002L;
    private static final long ROOT_SESSION_ID = 2105000000000000003L;
    private static final long TURN_ID = 2105000000000000004L;
    /** 框架下发的本轮模型调用身份；监听器只透传，不解读。 */
    private static final UUID RESPONSE_ID = UUID.fromString("6f1a1c2e-9b3d-4a5f-8e7c-0d1b2a3c4d5e");

    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();
    private final SseEventPublisher publisher = mock(SseEventPublisher.class);
    private final ExecutionIdentity identity = mock(ExecutionIdentity.class);
    private final AgentEventListener listener =
            new AgentEventListener(objectMapper, publisher, identity);

    /** 「流仍然连着」用的真实传输层：mock emitter 挂在真注册表里，连接数才是可断言的结果。 */
    private final SseEventPublisher livePublisher = new SseEventPublisher() {
        @Override
        protected SseEmitter newEmitter() {
            SseEmitter emitter = mock(SseEmitter.class);
            liveEmitters.add(emitter);
            return emitter;
        }
    };
    private final List<SseEmitter> liveEmitters = new ArrayList<>();
    private final AgentEventListener liveListener =
            new AgentEventListener(objectMapper, livePublisher, identity);

    @BeforeEach
    void setUp() {
        listener.init();
        liveListener.init();
    }

    @AfterEach
    void tearDown() {
        livePublisher.close();
    }

    /** 挂一条真实的会话流，返回它的 emitter 以便断言「确实写进去了」。 */
    private SseEmitter mountSessionStream() {
        livePublisher.connect(ROOT_SESSION_ID);
        return liveEmitters.get(liveEmitters.size() - 1);
    }

    @Test
    void partialTextRoutesToRootSession() {
        resolveSession();
        AgentPartialTextEvent event = new AgentPartialTextEvent("agent", EXECUTION_ID, RESPONSE_ID, "你好",
                Map.of("turnId", Long.toString(TURN_ID)), null);

        listener.onPartialText(event);

        assertSame(event, publishedEvent(AgentPartialTextEvent.class).getValue());
        verifySingleIdentityResolution();
    }

    @Test
    void executionStartRoutesToRootSession() {
        resolveSession();
        ExecutionStartEvent event = new ExecutionStartEvent(EXECUTION_ID,
                Map.of("turnId", Long.toString(TURN_ID)));

        listener.onExecutionStart(event);

        assertEquals(EXECUTION_ID, publishedEvent(ExecutionStartEvent.class).getValue().executionId());
        verifySingleIdentityResolution();
    }

    @Test
    void contextUpdateRoutesToRootSession() {
        resolveSession();
        ContextUpdateEvent event =
                new ContextUpdateEvent(EXECUTION_ID, ContextUpdateEvent.Phase.UPDATE, null, "用量刷新");

        listener.onContextUpdate(event);

        assertSame(event, publishedEvent(ContextUpdateEvent.class).getValue());
    }

    /** 工具生命周期事件同样按根会话广播。 */
    @Test
    void toolLifecycleEventsBroadcastToRootSession() {
        resolveSession();
        Map<String, Object> metadata = Map.of(
                "sessionId", Long.toString(SESSION_ID),
                "turnId", Long.toString(TURN_ID));

        listener.onToolCall(new ToolCallStartEvent("call_1", EXECUTION_ID, "read_file", "{}", RESPONSE_ID, metadata));
        listener.onToolCallOutput(new ToolCallEndEvent("call_1", EXECUTION_ID, RESPONSE_ID, "read_file", "{}", "内容",
                metadata, ToolCallStatus.COMPLETED));

        verify(publisher, org.mockito.Mockito.times(2))
                .publish(eq(ROOT_SESSION_ID), org.mockito.ArgumentMatchers.any(AgentEvent.class));
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "\t"})
    void missingExecutionIdIsDroppedBeforeLookups(String executionId) {
        listener.onExecutionStart(new ExecutionStartEvent(executionId));

        verifyNoInteractions(identity, publisher);
    }

    @Test
    void unknownExecutionIsDropped() {
        when(identity.sessionId(EXECUTION_ID)).thenThrow(new IllegalStateException("unknown execution"));

        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID));

        verifyNoInteractions(publisher);
    }

    @Test
    void unknownRootSessionIsDropped() {
        when(identity.sessionId(EXECUTION_ID)).thenReturn(SESSION_ID);
        when(identity.resolveRootSessionId(SESSION_ID)).thenThrow(new IllegalStateException("unknown session"));

        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID));

        verifyNoInteractions(publisher);
    }

// ------------------------------------------------------------------
    // 终态：照常广播，会话流保持连接
    // ------------------------------------------------------------------

    /**
     * 根执行完成：终态事件照常投递到根会话。
     *
     * <p>这里用 mock publisher 断言「广播了什么」；「流有没有被关」由下面的
     * {@link #terminalEventsKeepSessionStreamConnected} 用真实连接数断言。</p>
     */
    @Test
    @DisplayName("根执行完成：广播终态事件到根会话")
    void rootCompletionBroadcastsTerminalEvent() {
        resolveRootExecution();
        ExecutionCompleteEvent event = new ExecutionCompleteEvent(EXECUTION_ID, null);

        listener.onExecutionCompleted(event);

        verify(publisher).publish(ROOT_SESSION_ID, event);
    }

    /** 失败 / 取消与完成同口径：都只广播。 */
    @Test
    @DisplayName("根执行失败 / 取消：照常广播到根会话")
    void failureAndCancellationBroadcastTerminalEvents() {
        resolveRootExecution();
        ExecutionErrorEvent failure = new ExecutionErrorEvent("boom", null, EXECUTION_ID);
        ExecutionCancelledEvent cancelled = new ExecutionCancelledEvent(EXECUTION_ID);

        listener.onExecutionError(failure);
        listener.onExecutionCancelled(cancelled);

        verify(publisher).publish(ROOT_SESSION_ID, failure);
        verify(publisher).publish(ROOT_SESSION_ID, cancelled);
    }

    /** 子执行终结（某次委派完成）同样只是广播：事件仍归到根会话那条流上。 */
    @Test
    @DisplayName("子会话执行终结：广播到根会话")
    void subSessionTerminalBroadcastsToRootSession() {
        resolveSession();
        ExecutionCompleteEvent event = new ExecutionCompleteEvent(EXECUTION_ID, null);

        listener.onExecutionCompleted(event);

        verify(publisher).publish(ROOT_SESSION_ID, event);
    }

    /**
     * 完成 / 失败 / 取消走完一遍后，<b>会话流仍然连着</b>。
     *
     * <p>断言的是<b>结果</b>（连接数不变、emitter 仍收到写入），不是「某个方法没被调用」——
     * 后者守着的是一个名字：方法删了断言就失效，方法改名还会假绿。早先这里正是
     * {@code verify(never()).disconnectRoot(...)}，现在换成契约本身。</p>
     */
    @Test
    @DisplayName("完成 / 失败 / 取消：会话流仍然连着（断言连接数，不靠断言方法没被调）")
    void terminalEventsKeepSessionStreamConnected() throws java.io.IOException {
        resolveRootExecution();
        SseEmitter emitter = mountSessionStream();
        int connected = livePublisher.connectedCount();

        liveListener.onExecutionCompleted(new ExecutionCompleteEvent(EXECUTION_ID, null));
        liveListener.onExecutionError(new ExecutionErrorEvent("boom", null, EXECUTION_ID));
        liveListener.onExecutionCancelled(new ExecutionCancelledEvent(EXECUTION_ID));

        // 终态事件确实写进了这条流（挂载时的 READY 之外，每条终态各一帧）。
        verify(emitter, times(4)).send(any(SseEmitter.SseEventBuilder.class));
        assertEquals(connected, livePublisher.connectedCount(),
                "执行终结不得摘掉会话流：连接还在，前端下一次发送前无需重挂");
    }

    /** 挂起不是终结：恢复后的整轮事件仍要经这条流下发。 */
    @Test
    @DisplayName("挂起照常广播到根会话")
    void suspendedBroadcastsToRootSession() {
        resolveRootExecution();
        ExecutionSuspendedEvent event = new ExecutionSuspendedEvent(EXECUTION_ID);

        listener.onExecutionSuspended(event);

        verify(publisher).publish(ROOT_SESSION_ID, event);
    }

    /** 执行无归属：事件丢弃，也不关任何流（不能凭缺失身份去关别人的会话）。 */
    @Test
    @DisplayName("执行无归属：终态事件丢弃，不关任何流")
    void unknownExecutionTerminalDoesNotCloseStream() {
        when(identity.sessionId(EXECUTION_ID)).thenThrow(new IllegalStateException("unknown execution"));

        listener.onExecutionCompleted(new ExecutionCompleteEvent(EXECUTION_ID, null));

        verifyNoInteractions(publisher);
    }

    private void resolveSession() {
        when(identity.sessionId(EXECUTION_ID)).thenReturn(SESSION_ID);
        when(identity.resolveRootSessionId(SESSION_ID)).thenReturn(ROOT_SESSION_ID);
    }

    /** 根自身的执行：执行所属会话即根会话。 */
    private void resolveRootExecution() {
        when(identity.sessionId(EXECUTION_ID)).thenReturn(ROOT_SESSION_ID);
        when(identity.resolveRootSessionId(ROOT_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
    }

    private void verifySingleIdentityResolution() {
        verify(identity).sessionId(EXECUTION_ID);
        verify(identity).resolveRootSessionId(SESSION_ID);
        verifyNoMoreInteractions(identity);
    }

    /** 捕获投递到根会话的那条事件；泛型只用于调用点取字段，类型断言交给测试自身。 */
    @SuppressWarnings("unchecked")
    private <T extends AgentEvent> ArgumentCaptor<T> publishedEvent(Class<T> type) {
        ArgumentCaptor<AgentEvent> captor = ArgumentCaptor.forClass(AgentEvent.class);
        verify(publisher).publish(eq(ROOT_SESSION_ID), captor.capture());
        AgentEvent value = captor.getValue();
        org.junit.jupiter.api.Assertions.assertTrue(type.isInstance(value),
                "投递的事件类型应为 " + type.getSimpleName() + "，实际 " + value.getClass().getSimpleName());
        return (ArgumentCaptor<T>) (ArgumentCaptor<?>) captor;
    }
}
