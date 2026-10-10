package com.summit.dp.agent.application.service.impl;

import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.application.service.impl.ExecutionQueryServiceImpl;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
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
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 交付总监独立验证（QA 严过关）—— AC-6 / P0-4 的<b>端到端作用域</b>用例。
 *
 * <p>工程师用例把 {@code ExecutionQueryService} 整个 mock 掉，只验证「传进去的是 List.of(root)」，
 * 并未证明「子执行的记录真的不会进入判定」。本用例改用真实的 {@code ExecutionQueryServiceImpl}
 * + 一个按 {@code session_id IN (...)} 语义过滤的仓储桩：把「协作式子代理仍在跑，用户却能开新一轮」
 * 这条主张，落到查询链路（查询服务按 sessionId 分组 → 守卫只看根）上验证。</p>
 *
 * <p>反向对照：同一条非终态执行，只要它的 {@code session_id} 是<b>根</b>，就必须被拦住 ——
 * 证明守卫没被悄悄删掉，只是作用域收敛到了根执行。</p>
 */
class QaIdleGuardScopeTest {

    private static final Long ROOT_SESSION_ID = 800L;
    private static final Long CHILD_SESSION_ID = 555L;

    /** 模拟 SQL：WHERE session_id IN (sessionIds)。 */
    private final List<Execution> stored = new ArrayList<>();
    private final ExecutionRepository domainRepository = mock(ExecutionRepository.class);

    private final ChatServiceImpl service;

    QaIdleGuardScopeTest() {
        when(domainRepository.findLatestBySessionAndStatus(any())).thenAnswer(invocation -> {
            Collection<Long> scope = invocation.getArgument(0);
            return stored.stream()
                    .filter(e -> e.getSessionId() != null && scope.contains(e.getSessionId()))
                    .toList();
        });
        ExecutionQueryServiceImpl realQueryService = new ExecutionQueryServiceImpl(domainRepository);

        this.service = new ChatServiceImpl(
                mock(SseEventPublisher.class),
                mock(RequestPreparer.class),
                mock(ExecutionControl.class),
                mock(com.summit.core.runtime.loop.ExecutionRepository.class),
                mock(SessionRepository.class),
                mock(SessionExecutionRegistry.class),
                mock(ModelContextService.class),
                mock(ExecutionIdentity.class),
                mock(ToolCallRepository.class),
                mock(SessionAttributeRestorer.class),
                mock(PreparedChatExecutor.class),
                mock(ChatTurnService.class),
                realQueryService,
                mock(ResendTargetResolver.class),
                mock(ConversationRollbackService.class));
    }

    private Execution execution(Long sessionId, int statusCode) {
        Execution execution = new Execution();
        execution.setId((long) (stored.size() + 1));
        execution.setSessionId(sessionId);
        execution.setStatus(statusCode); // 0=CREATED 1=RUNNING 2=SUSPENDED 3=COMPLETED 4=FAILED 5=CANCELLED
        return execution;
    }

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
    @DisplayName("AC-6 正向：根执行已完（终态）+ 子代理 RUNNING → 放行，且判定作用域只含根会话")
    void childRunningDoesNotBlockNewRound() {
        stored.add(execution(ROOT_SESSION_ID, 3));   // 根：COMPLETED
        stored.add(execution(CHILD_SESSION_ID, 1));  // 子：RUNNING（协作式子代理仍在跑）

        assertDoesNotThrow(this::invokeEnsureRootExecutionIdle,
                "子代理在跑不得拦住新一轮（P0-4）");

        ArgumentCaptor<Collection<Long>> scope = ArgumentCaptor.forClass(Collection.class);
        verify(domainRepository).findLatestBySessionAndStatus(scope.capture());
        assertEquals(List.of(ROOT_SESSION_ID), List.copyOf(scope.getValue()),
                "查询作用域只允许是根会话自身");
        assertFalse(scope.getValue().contains(CHILD_SESSION_ID));
    }

    @Test
    @DisplayName("AC-6 反向对照：非终态执行只要 session_id=根，就必须被拦（守卫未被削掉）")
    void rootRunningStillBlocks() {
        stored.add(execution(ROOT_SESSION_ID, 1)); // 根：RUNNING

        assertThrows(ClientException.class, this::invokeEnsureRootExecutionIdle,
                "根执行仍在跑必须拒绝（单飞约束不变）");
    }

    @Test
    @DisplayName("AC-6 反向对照：把那条子执行故意建成 session_id=根，守卫必须拦住")
    void childMisattributedToRootIsCaught() {
        // 故意把「跑着的子执行」写成 session_id=根：作用域内出现非终态 → 必须拒绝。
        stored.add(execution(ROOT_SESSION_ID, 1));

        assertThrows(ClientException.class, this::invokeEnsureRootExecutionIdle,
                "若子执行被错误挂到根会话下，守卫必须拦住（证明作用域收敛才是放行原因）");
    }

    @Test
    @DisplayName("AC-6 边界：根执行 CREATED / SUSPENDED 仍拦；根无任何执行放行")
    void createdAndSuspendedStillBlock() {
        stored.add(execution(ROOT_SESSION_ID, 0)); // CREATED
        assertThrows(ClientException.class, this::invokeEnsureRootExecutionIdle);

        stored.clear();
        stored.add(execution(ROOT_SESSION_ID, 2)); // SUSPENDED
        assertThrows(ClientException.class, this::invokeEnsureRootExecutionIdle);

        stored.clear();
        assertDoesNotThrow(this::invokeEnsureRootExecutionIdle, "根无执行事实应放行");
    }
}
