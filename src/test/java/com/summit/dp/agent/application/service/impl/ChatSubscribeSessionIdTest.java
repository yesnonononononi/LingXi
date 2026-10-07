package com.summit.dp.agent.application.service.impl;

import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
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
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@code GET /a/completion/{sessionId}/events} 的入口校验与根会话解析。
 *
 * <p>{@code 0} 是「自身即根」的哨兵值（{@code Session.ROOT_SESSION_ID}），不是合法会话主键。
 * 客户端传 0 时若直接落到 {@code ExecutionIdentity.resolveRootSessionId} 会抛
 * {@code IllegalStateException("Unknown session: 0")}，被兜底 handler 顶成 HTTP 500
 * 「系统繁忙，请稍后再试」。入口必须先把非正数拒绝为业务错误。</p>
 */
class ChatSubscribeSessionIdTest {

    private static final long SESSION_ID = 42L;
    private static final long ROOT_SESSION_ID = 7L;

    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final RequestPreparer requestPreparer = mock(RequestPreparer.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final SessionExecutionRegistry sessionExecutionRegistry = mock(SessionExecutionRegistry.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);

    private ChatServiceImpl service() {
        return new ChatServiceImpl(sseEventPublisher, requestPreparer, executionControl,
                executionRepository, sessionRepository, sessionExecutionRegistry, modelContextService,
                executionIdentity, toolCallRepository,
                new SessionAttributeRestorer(sessionRepository),
                new PreparedChatExecutor(mock(AgentWorkflowOrchestrator.class), requestPreparer,
                        modelContextService, sessionExecutionRegistry, executionControl),
                mock(ChatTurnService.class),
                mock(ExecutionQueryService.class),
                mock(ResendTargetResolver.class), mock(ConversationRollbackService.class));
    }

    @Test
    @DisplayName("订阅会话标识为 0：拒成业务错误，绝不解析成根会话（否则兜底 handler 报 500）")
    void subscribeRejectsZeroSessionId() {
        ChatServiceImpl service = service();

        assertThrows(ClientException.class, () -> service.subscribeSession(0L),
                "0 是「自身即根」哨兵，不是合法会话主键，必须按业务错误拒绝");
        verify(executionIdentity, never()).resolveRootSessionId(0L);
        verify(sseEventPublisher, never()).connect(0L);
    }

    @Test
    @DisplayName("订阅会话标识为空：拒成业务错误")
    void subscribeRejectsNullSessionId() {
        assertThrows(ClientException.class, () -> service().subscribeSession(null));
    }

    @Test
    @DisplayName("订阅合法会话标识：解析到根会话后建流（守卫不得误伤正常订阅）")
    void subscribeResolvesRootAndConnects() {
        SseEmitter emitter = mock(SseEmitter.class);
        when(executionIdentity.resolveRootSessionId(SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(sseEventPublisher.connect(ROOT_SESSION_ID)).thenReturn(emitter);

        SseEmitter returned = service().subscribeSession(SESSION_ID);

        assertEquals(emitter, returned);
        verify(sseEventPublisher).connect(ROOT_SESSION_ID);
    }
}
