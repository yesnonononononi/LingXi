package com.summit.dp.agent.api.controller;

import com.summit.dp.agent.application.service.ChatService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@code /a/completion/{sessionId}/events} 的订阅行为。
 *
 * <p>v3/v2 事件渲染链路已删除，本入口只保留一条会话级 SSE 通道：
 * 直接委托 {@link ChatService#subscribeSession(Long)}，不再按 schemaVersion 分派。</p>
 */
class ChatSubscribeSchemaVersionTest {

    private static final long SESSION_ID = 42L;

    private final ChatService chatService = mock(ChatService.class);

    @Test
    @DisplayName("订阅会话事件流：原样委托给 ChatService，不额外分派")
    void subscribeDelegatesToChatService() {
        SseEmitter emitter = mock(SseEmitter.class);
        when(chatService.subscribeSession(SESSION_ID)).thenReturn(emitter);
        ChatController controller = new ChatController(chatService);

        SseEmitter returned = controller.subscribe(SESSION_ID);

        assertEquals(emitter, returned);
        verify(chatService).subscribeSession(SESSION_ID);
    }
}
