package com.summit.dp.agent.api.controller;

import com.summit.dp.agent.application.service.ChatService;
import com.summit.dp.agent.application.service.impl.ChatCommandAcceptance;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import com.summit.dp.stream.application.service.SessionStreamHub;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@code /a/completion/{sessionId}/events} 的 schemaVersion 分派。
 *
 * <p>第 4 步引入 v3 协议后，这条入口必须把 {@code schemaVersion=3} 精确路由到
 * {@link EventStreamPublisher}（只登记连接、发 STREAM_READY，不查业务库），
 * 且不得顺带触发 v1/v2 分支（那会把同一条订阅路线重复挂载）。</p>
 */
class ChatSubscribeSchemaVersionTest {

    private static final long SESSION_ID = 42L;
    private static final long ROOT_SESSION_ID = 100L;

    private final ChatService chatService = mock(ChatService.class);
    private final ChatCommandAcceptance chatCommandAcceptance = mock(ChatCommandAcceptance.class);
    private final SessionStreamHub streamHub = mock(SessionStreamHub.class);
    private final EventStreamPublisher eventStreamPublisher = mock(EventStreamPublisher.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);

    private ChatController controller;

    @BeforeEach
    void setup() {
        controller = new ChatController(chatService, chatCommandAcceptance);
        // @Autowired 字段无 setter；用反射注入替身（与既有测试同一手法）。
        ReflectionTestUtils.setField(controller, "streamHub", streamHub);
        ReflectionTestUtils.setField(controller, "eventStreamPublisher", eventStreamPublisher);
        ReflectionTestUtils.setField(controller, "executionIdentity", executionIdentity);
    }

    @Test
    @DisplayName("schemaVersion=3 路由到 v3 发布器，传根会话；不碰 v1/v2")
    void schemaVersionThreeRoutesToV3Publisher() {
        when(executionIdentity.resolveRootSessionId(SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        SseEmitter emitter = mock(SseEmitter.class);
        when(eventStreamPublisher.subscribe(ROOT_SESSION_ID)).thenReturn(emitter);

        SseEmitter returned = controller.subscribe(SESSION_ID, 3);

        assertEquals(emitter, returned);
        verify(eventStreamPublisher).subscribe(ROOT_SESSION_ID);
        // v3 分支必须与 v1/v2 互斥：同一订阅不得被两条路线各挂一次。
        verify(streamHub, never()).subscribe(org.mockito.ArgumentMatchers.anyLong());
        verify(chatService, never()).subscribeSession(org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    @DisplayName("schemaVersion=2 仍走 SessionStreamHub，不碰 v3 发布器")
    void schemaVersionTwoRoutesToHub() {
        when(executionIdentity.resolveRootSessionId(SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(streamHub.subscribe(ROOT_SESSION_ID)).thenReturn(mock(SseEmitter.class));

        controller.subscribe(SESSION_ID, 2);

        verify(streamHub).subscribe(ROOT_SESSION_ID);
        verify(eventStreamPublisher, never()).subscribe(org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    @DisplayName("未知 schemaVersion 直接拒绝，落到任何一条流路线都不行")
    void unknownSchemaVersionIsRejected() {
        assertThrows(IllegalArgumentException.class, () -> controller.subscribe(SESSION_ID, 9));
        verify(eventStreamPublisher, never()).subscribe(org.mockito.ArgumentMatchers.anyLong());
        verify(streamHub, never()).subscribe(org.mockito.ArgumentMatchers.anyLong());
        verify(chatService, never()).subscribeSession(org.mockito.ArgumentMatchers.anyLong());
    }
}
