package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.ConversationRollbackService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.service.ChatTurnService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.Collection;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * P0-4 空闲判定澄清的回归守卫：{@code ensureRootExecutionIdle} <b>只看根会话自身的执行</b>。
 *
 * <p>本用例锁两条不变量（回退即变红）：</p>
 * <ol>
 *   <li><b>查询作用域 = 单个根会话 id</b>：判定数据只按 {@code List.of(rootSessionId)} 取，
 *       绝不扩大到整棵会话树 —— 否则协作模式下「子代理仍在跑」会把用户开新一轮挡住。</li>
 *   <li><b>根执行非终态仍拦</b>（单飞约束不变）：根会话自身 RUNNING / CREATED / SUSPENDED 一律拒绝。</li>
 * </ol>
 */
class ChatServiceImplIdleGuardTest {

    private static final Long ROOT_SESSION_ID = 800L;
    /** 子会话 id：判定作用域里<b>不允许</b>出现它。 */
    private static final Long CHILD_SESSION_ID = 555L;

    private final ExecutionQueryService executionQueryService = mock(ExecutionQueryService.class);
    private final ChatServiceImpl service = new ChatServiceImpl(
            mock(SseEventPublisher.class),
            mock(RequestPreparer.class),
            mock(ExecutionControl.class),
            mock(ExecutionRepository.class),
            mock(SessionRepository.class),
            mock(SessionExecutionRegistry.class),
            mock(ModelContextService.class),
            mock(ExecutionIdentity.class),
            mock(ToolCallRepository.class),
            mock(SessionAttributeRestorer.class),
            mock(PreparedChatExecutor.class),
            mock(ChatTurnService.class),
            executionQueryService,
            mock(ResendTargetResolver.class),
            mock(ConversationRollbackService.class));

    private void stubStates(List<ExecutionState> states) {
        when(executionQueryService.latestStatesBySession(any()))
                .thenReturn(states == null ? Map.of() : Map.of(ROOT_SESSION_ID, states));
    }

    /** 直接反射调用私有方法：入口链需要大量协作，这里只验证判定本身。 */
    private void invokeEnsureRootExecutionIdle() {
        try {
            Method method = ChatServiceImpl.class.getDeclaredMethod("ensureRootExecutionIdle", long.class);
            method.setAccessible(true);
            method.invoke(service, ROOT_SESSION_ID);
        } catch (InvocationTargetException e) {
            if (e.getTargetException() instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw new IllegalStateException(e.getTargetException());
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    @DisplayName("作用域 = 单个根会话 id：子代理在跑（不在判定范围）不拦用户开新一轮")
    void queriesOnlyRootSessionScopeAndChildRunningDoesNotBlock() {
        // 根执行已终结；子代理的 RUNNING 因 session_id=子会话，不在本次查询结果里。
        stubStates(List.of(ExecutionState.COMPLETED));

        assertDoesNotThrow(this::invokeEnsureRootExecutionIdle,
                "子代理在跑不得拦住新一轮（协作模式 P0-4）");

        ArgumentCaptor<Collection<Long>> scope = ArgumentCaptor.forClass(Collection.class);
        verify(executionQueryService).latestStatesBySession(scope.capture());
        assertEquals(List.of(ROOT_SESSION_ID), List.copyOf(scope.getValue()),
                "只允许查询根会话自身的执行");
        assertFalse(scope.getValue().contains(CHILD_SESSION_ID), "子会话 id 不得进入空闲判定作用域");
    }

    @Test
    @DisplayName("根执行 RUNNING：仍被拒绝（单飞约束对根执行保持不变）")
    void rootRunningStillBlocks() {
        stubStates(List.of(ExecutionState.RUNNING));
        assertThrows(ClientException.class, this::invokeEnsureRootExecutionIdle);
    }

    @Test
    @DisplayName("根执行 CREATED（恢复态在跑）：仍被拒绝")
    void rootCreatedStillBlocks() {
        stubStates(List.of(ExecutionState.CREATED));
        assertThrows(ClientException.class, this::invokeEnsureRootExecutionIdle);
    }

    @Test
    @DisplayName("根执行 SUSPENDED：仍被拒绝（先处理待审批事项 / 恢复）")
    void rootSuspendedStillBlocks() {
        stubStates(List.of(ExecutionState.SUSPENDED));
        assertThrows(ClientException.class, this::invokeEnsureRootExecutionIdle);
    }

    @Test
    @DisplayName("根会话无执行事实：放行")
    void noExecutionsAllowed() {
        stubStates(null);
        assertDoesNotThrow(this::invokeEnsureRootExecutionIdle);
    }
}
