package com.summit.dp.workflow.infrastructure.device;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.device.application.model.DeviceCommand;
import com.summit.dp.device.application.model.DeviceCommandAck;
import com.summit.dp.device.interfaces.ws.DeviceWsProperties;
import com.summit.dp.workflow.application.chat.ChatAcceptanceVO;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.ChatService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 手机指令 → 会话受理的翻译层。
 *
 * <p>这层看起来只有三行逻辑，但它守的是最贵的两条底线：</p>
 * <ol>
 *   <li><b>不能白给</b>：开关关着就不许远程遥控电脑跑任务；</li>
 *   <li><b>不能跑两遍</b>：手机重连重发是常态，重复执行一次任务的代价远大于一次拒绝。</li>
 * </ol>
 */
class DeviceCommandChatHandlerTest {

    private static final String DEVICE_ID = "px7a-cmd";

    private ChatService chatService;
    private DeviceWsProperties properties;
    private DeviceCommandChatHandler handler;

    @BeforeEach
    void setUp() {
        chatService = mock(ChatService.class);
        properties = new DeviceWsProperties();
        handler = new DeviceCommandChatHandler(chatService, properties);
    }

    private void enable() {
        properties.setCommandEnabled(true);
    }

    private void acceptWith(Long sessionId, String pendingId) {
        when(chatService.acceptCommand(any())).thenReturn(Result.success(
                ChatAcceptanceVO.builder().sessionId(sessionId).pendingId(pendingId).build()));
    }

    @Test
    @DisplayName("① 开关关闭时拒绝，且绝不碰会话编排")
    void 开关关闭时拒绝() {
        DeviceCommandAck ack = handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "打开无线调试", null));

        assertFalse(ack.accepted());
        assertTrue(ack.reason().contains("未开启"), ack.reason());
        verify(chatService, never()).acceptCommand(any());
    }

    @Test
    @DisplayName("② 空白与超长指令在本地拒绝，不落到模型")
    void 空白与超长指令被拒() {
        enable();

        assertFalse(handler.handle(DEVICE_ID, new DeviceCommand("c1", "   ", null)).accepted());
        assertFalse(handler.handle(DEVICE_ID, new DeviceCommand("c2", "x".repeat(4001), null)).accepted());
        verify(chatService, never()).acceptCommand(any());
    }

    @Test
    @DisplayName("③ 正常指令受理并返回会话号，会话号被记住")
    void 正常指令被受理并绑定会话() {
        enable();
        acceptWith(12L, null);

        DeviceCommandAck ack = handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "打开无线调试", null));

        assertTrue(ack.accepted());
        assertEquals(12L, ack.sessionId());
        assertNull(ack.pendingId());
    }

    @Test
    @DisplayName("④ 同一设备追问复用同一会话，而不是每条指令新建一个")
    void 追问复用同一会话() {
        enable();
        acceptWith(12L, null);
        handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "第一句", null));
        acceptWith(12L, null);

        handler.handle(DEVICE_ID, new DeviceCommand("cmd-2", "那它现在到哪一步了", null));

        ArgumentCaptor<ChatCommand> captor = ArgumentCaptor.forClass(ChatCommand.class);
        verify(chatService, times(2)).acceptCommand(captor.capture());
        assertEquals(12L, captor.getAllValues().get(1).sessionId(),
                "第二次必须带上一轮的 sessionId，否则追问等于重新开始");
    }

    @Test
    @DisplayName("⑤ 同一 commandId 重放不再执行，但回执仍是「已受理」")
    void 重放不重复执行() {
        enable();
        acceptWith(12L, null);
        handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "打开无线调试", null));

        DeviceCommandAck replay = handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "打开无线调试", null));

        verify(chatService, times(1)).acceptCommand(any());
        assertTrue(replay.accepted(), "重放回成失败会让用户以为没发出去，然后手点第二次");
        assertTrue(replay.reason().contains("未重复执行"), replay.reason());
        assertEquals(12L, replay.sessionId());
    }

    @Test
    @DisplayName("⑥ 受理失败不占幂等位，修好后可以重发同一条")
    void 失败不占幂等位() {
        enable();
        when(chatService.acceptCommand(any())).thenReturn(Result.error("会话正忙"));

        DeviceCommandAck rejected = handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "打开无线调试", null));
        assertFalse(rejected.accepted());
        assertEquals("会话正忙", rejected.reason());

        acceptWith(12L, null);
        DeviceCommandAck retried = handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "打开无线调试", null));

        assertTrue(retried.accepted(), "被拒过的指令必须能重发，否则用户只能换个说法绕过去");
        verify(chatService, times(2)).acceptCommand(any());
    }

    @Test
    @DisplayName("⑦ 会话忙时把 pendingId 透传回去：受理 ≠ 已执行")
    void 排队时透传pendingId() {
        enable();
        acceptWith(12L, "pending-9");

        DeviceCommandAck ack = handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "打开无线调试", null));

        assertTrue(ack.accepted());
        assertEquals("pending-9", ack.pendingId());
    }

    @Test
    @DisplayName("⑧ 指令自带 sessionId 时以它为准")
    void 指令指定会话时优先() {
        enable();
        acceptWith(77L, null);

        handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "切到那个会话继续", 66L));

        ArgumentCaptor<ChatCommand> captor = ArgumentCaptor.forClass(ChatCommand.class);
        verify(chatService).acceptCommand(captor.capture());
        assertEquals(66L, captor.getValue().sessionId());
    }

    @Test
    @DisplayName("⑨ 编排抛异常也要有回执，不能让手机端干等")
    void 异常也回执() {
        enable();
        when(chatService.acceptCommand(any())).thenThrow(new IllegalStateException("数据库挂了"));

        DeviceCommandAck ack = handler.handle(DEVICE_ID, new DeviceCommand("cmd-1", "打开无线调试", null));

        assertFalse(ack.accepted());
        assertTrue(ack.reason().contains("数据库挂了"), ack.reason());
    }
}
