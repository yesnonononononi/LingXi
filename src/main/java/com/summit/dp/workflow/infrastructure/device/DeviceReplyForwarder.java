package com.summit.dp.workflow.infrastructure.device;

import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.event.AgentMessageEvent;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.device.application.DeviceRegistry;
import com.summit.dp.device.application.model.DeviceReply;
import com.summit.dp.device.application.port.DeviceChannel;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.workflow.application.chat.ExecutionErrorText;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 把设备发起的会话结果回推给手机。
 *
 * <p>它只做一件事：认出"这条事件属于哪台设备"，然后把结论推过去。三条边界写在代码里：</p>
 * <ol>
 *   <li><b>只推设备会话</b>：桌面端自己开的会话一个字节都不推，否则手机成了桌面端聊天的镜像。</li>
 *   <li><b>失败也要推</b>：只在成功时推，手机就永远停在"已受理"——那比明确失败更糟，用户会一直等。</li>
 *   <li><b>设备不在线就丢弃、不排队重放</b>：十分钟前的旧答复补到手机上，等于让人对着过期结论做决定。</li>
 * </ol>
 *
 * <p><b>为什么订阅框架事件而不是从 SSE 里抠字符串</b>：事件是权威来源，SSE 是给桌面前端的
 * 展示层转发。从展示文本反解业务语义，界面文案一改就全崩。</p>
 *
 * <p><b>为什么不算"流式"</b>：手机端要的是"做完了没有、结果是什么"，不是逐字渲染。
 * 把数百个 token 分片推过去，等于把一个聊天客户端塞进 App，而 App 不负责渲染会话。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DeviceReplyForwarder implements RuntimeListener {

    /** 执行完成但一条文本都没有时的兜底文案。沉默比一句"没有文本"更容易被误解成断线。 */
    private static final String NO_TEXT = "本轮已完成，但没有产生文本答复。";

    private final DeviceSessionBindings bindings;
    private final DeviceRegistry registry;

    /**
     * sessionId → 最近一条非空 AI 文本。
     *
     * <p>执行完成事件本身不带正文，正文只能从 {@link AgentMessageEvent} 里攒。
     * 用「最后一次非空」而不是拼接全部分片：分片是增量还是全量由模型适配层决定，
     * 拼接会在"全量"语义下把同一段话叠好几遍，而取最后一条在两种语义下都成立。</p>
     */
    private final Map<Long, String> lastText = new ConcurrentHashMap<>();

    @Override
    public void onAiMessage(AgentMessageEvent event) {
        String text = textOf(event);
        if (text == null || text.isBlank()) {
            // 工具调用轮里 text 为空：用它覆盖，真正的答复就再也找不回来了
            return;
        }
        Long sessionId = ExecutionEventMetadata.sessionId(event.eventMetaData());
        if (sessionId == null) {
            return;
        }
        if (bindings.deviceOf(sessionId).isEmpty()) {
            // 桌面端自己的会话：不缓存、不回推，免得白占内存
            return;
        }
        lastText.put(sessionId, text);
    }

    @Override
    public void onExecutionCompleted(ExecutionCompleteEvent event) {
        Long sessionId = ExecutionEventMetadata.sessionId(event.eventMetaData());
        if (!isDeviceSession(sessionId)) {
            return;
        }
        String text = lastText.remove(sessionId);
        push(DeviceReply.finalReply(sessionId,
                text == null || text.isBlank() ? NO_TEXT : text,
                null,
                ExecutionEventMetadata.turnId(event.eventMetaData())));
    }

    @Override
    public void onExecutionError(ExecutionErrorEvent event) {
        Long sessionId = ExecutionEventMetadata.sessionId(event.eventMetaData());
        if (!isDeviceSession(sessionId)) {
            return;
        }
        // 失败后清掉半截文本：下一轮开始时不该还挂着上一轮的残留
        lastText.remove(sessionId);
        push(DeviceReply.error(sessionId, ExecutionErrorText.resolve(event), null));
    }

    private boolean isDeviceSession(Long sessionId) {
        return sessionId != null && bindings.deviceOf(sessionId).isPresent();
    }

    private void push(DeviceReply reply) {
        Optional<String> deviceId = bindings.deviceOf(reply.sessionId());
        if (deviceId.isEmpty()) {
            return;
        }
        Optional<DeviceChannel> channel = registry.channel(deviceId.get());
        if (channel.isEmpty()) {
            // 不排队、不重放：重连后补一条旧答复，用户会对着过期结论做决定
            log.info("设备不在线，回推已丢弃: deviceId={}, sessionId={}, kind={}",
                    deviceId.get(), reply.sessionId(), reply.kind().wire());
            return;
        }
        channel.get().pushReply(reply);
    }

    /**
     * 取一条 AI 消息的正文。
     *
     * <p>任何一环缺失都返回 null 而不是空串：空串会被当成"模型说了一句空白"，
     * 而缺失只说明这一帧没有正文——两者的处置不同（前者要显示，后者要跳过）。</p>
     */
    private static String textOf(AgentMessageEvent event) {
        ChatResponseEntity response = event.getChatResponseEntity();
        if (response == null || response.getAiMessageEntity() == null) {
            return null;
        }
        return response.getAiMessageEntity().getText();
    }
}
