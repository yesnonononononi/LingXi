package com.summit.dp.workflow.infrastructure.device;

import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.event.AgentMessageEvent;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.device.application.DeviceRegistry;
import com.summit.dp.device.application.model.DeviceReply;
import com.summit.dp.device.infrastructure.fake.FakeDeviceChannel;
import com.summit.dp.execution.ExecutionEventMetadata;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 结果回推：设备发起的会话跑完之后，结论必须回到那台设备上。
 *
 * <p>这些用例锁的是四条边界，而不是"方法被调用过"：只推设备会话、失败也推、
 * 工具轮的空文本不能覆盖真答复、设备不在线就丢弃而不是排队。</p>
 */
class DeviceReplyForwarderTest {

    private static final String DEVICE_ID = "px7a-reply";
    private static final long SESSION_ID = 12L;
    private static final long TURN_ID = 88L;
    private static final String EXECUTION_ID = "exec-reply-1";

    private final DeviceSessionBindings bindings = new DeviceSessionBindings();
    private final DeviceRegistry registry = new DeviceRegistry();
    private final FakeDeviceChannel device = new FakeDeviceChannel(DEVICE_ID);
    private final DeviceReplyForwarder forwarder = new DeviceReplyForwarder(bindings, registry);

    @BeforeEach
    void setUp() {
        registry.register(device);
        bindings.bind(DEVICE_ID, SESSION_ID);
    }

    // ---------------- 夹具 ----------------

    private static Map<String, Object> meta(long sessionId, Long turnId) {
        return ExecutionEventMetadata.of(sessionId, sessionId, turnId, null, 1L);
    }

    private static AgentMessageEvent aiMessage(String text, Map<String, Object> metadata) {
        ChatResponseEntity response = ChatResponseEntity.builder()
                .aiMessageEntity(new AiMessageEntity(text, null, List.of()))
                .build();
        return new AgentMessageEvent(response, EXECUTION_ID, "resp-1", metadata);
    }

    private static ExecutionCompleteEvent completed(Map<String, Object> metadata) {
        return new ExecutionCompleteEvent(EXECUTION_ID, null, metadata);
    }

    // ---------------- 用例 ----------------

    @Test
    @DisplayName("① 会话完成后，最终答复与轮次一起回到设备")
    void 最终答复回推设备() {
        Map<String, Object> metadata = meta(SESSION_ID, TURN_ID);

        forwarder.onAiMessage(aiMessage("无线调试已打开。", metadata));
        forwarder.onExecutionCompleted(completed(metadata));

        assertEquals(1, device.replies().size(), "应当只推一条最终答复: " + device.replies());
        DeviceReply reply = device.replies().get(0);
        assertEquals(DeviceReply.Kind.FINAL, reply.kind());
        assertEquals("无线调试已打开。", reply.text());
        assertEquals(SESSION_ID, reply.sessionId());
        assertEquals(TURN_ID, reply.turnId(), "轮次没带过去，手机端就没法把答复挂到对应提问上");
    }

    @Test
    @DisplayName("② 工具调用轮的空文本不得覆盖真正的答复")
    void 工具轮空文本不覆盖答复() {
        Map<String, Object> metadata = meta(SESSION_ID, TURN_ID);

        forwarder.onAiMessage(aiMessage("好的，我先看一下设置页。", metadata));
        // 工具调用轮：模型只发起调用，正文为空。若它覆盖了上一条，用户就只会看到兜底文案
        forwarder.onAiMessage(aiMessage(null, metadata));
        forwarder.onAiMessage(aiMessage("   ", metadata));
        forwarder.onExecutionCompleted(completed(metadata));

        assertEquals("好的，我先看一下设置页。", device.replies().get(0).text());
    }

    @Test
    @DisplayName("③ 桌面端自己的会话一个字节都不推")
    void 非设备会话不回推() {
        long desktopSession = 999L;
        Map<String, Object> metadata = meta(desktopSession, TURN_ID);

        forwarder.onAiMessage(aiMessage("这是桌面端的对话", metadata));
        forwarder.onExecutionCompleted(completed(metadata));

        assertTrue(device.replies().isEmpty(), "桌面端会话不该出现在手机上: " + device.replies());
    }

    @Test
    @DisplayName("④ 失败也要推 error，并剥掉异常类名")
    void 失败也回推() {
        Map<String, Object> metadata = meta(SESSION_ID, TURN_ID);

        forwarder.onExecutionError(new ExecutionErrorEvent(
                "java.lang.IllegalStateException: 模型调用超时", null, EXECUTION_ID, metadata));

        DeviceReply reply = device.replies().get(0);
        assertEquals(DeviceReply.Kind.ERROR, reply.kind());
        // 手机用户不需要看异常类名；规则与桌面端实时推送共用 ExecutionErrorText
        assertEquals("模型调用超时", reply.text());
    }

    @Test
    @DisplayName("⑤ 完成时没有正文也不沉默，给一句兜底")
    void 无正文时兜底文案() {
        Map<String, Object> metadata = meta(SESSION_ID, TURN_ID);

        forwarder.onExecutionCompleted(completed(metadata));

        DeviceReply reply = device.replies().get(0);
        assertEquals(DeviceReply.Kind.FINAL, reply.kind());
        assertTrue(reply.text().contains("没有产生文本答复"), reply.text());
    }

    @Test
    @DisplayName("⑥ 设备不在线时丢弃且不抛异常")
    void 设备不在线丢弃() {
        registry.unregister(DEVICE_ID);
        Map<String, Object> metadata = meta(SESSION_ID, TURN_ID);

        forwarder.onAiMessage(aiMessage("答复", metadata));
        forwarder.onExecutionCompleted(completed(metadata));

        assertTrue(device.replies().isEmpty(), "设备已摘除，不该再写进它的缓冲");
    }

    @Test
    @DisplayName("⑦ 设备改绑新会话后，旧会话的结果不再回到这台设备")
    void 改绑后旧会话不再回推() {
        long newSession = 34L;
        bindings.bind(DEVICE_ID, newSession);

        Map<String, Object> oldMetadata = meta(SESSION_ID, TURN_ID);
        forwarder.onAiMessage(aiMessage("旧会话的答复", oldMetadata));
        forwarder.onExecutionCompleted(completed(oldMetadata));

        assertTrue(device.replies().isEmpty(), "旧会话的答复推给手机，就是『我没问的问题的答案』");
    }
}
