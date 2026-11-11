package com.summit.dp.workflow.infrastructure.device;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.device.application.model.DeviceCommand;
import com.summit.dp.device.application.model.DeviceCommandAck;
import com.summit.dp.device.application.port.DeviceCommandHandler;
import com.summit.dp.device.interfaces.ws.DeviceWsProperties;
import com.summit.dp.workflow.application.chat.ChatAcceptanceVO;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.ChatService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 把手机发来的指令翻译成一次会话受理。
 *
 * <p>职责只有三件事，全部围绕"别把同一句话跑两遍"：</p>
 * <ol>
 *   <li><b>开关</b>：默认关闭，关闭时明确回绝；</li>
 *   <li><b>幂等</b>：同一 deviceId + commandId 只受理一次，重放直接回上次的回执；</li>
 *   <li><b>归属</b>：deviceId 绑定一个会话，首次新建、之后复用，追问才有上下文。</li>
 * </ol>
 *
 * <p>它不做的事：不执行动作、不等待 agent 结果、不推流。手机端只要"受理了没有"，
 * 真正的执行进度属于会话自己的事件流。</p>
 */
@Slf4j
@Component
public class DeviceCommandChatHandler implements DeviceCommandHandler {

    /** 与契约 schema 的 text.maxLength 对齐。 */
    private static final int MAX_TEXT_LENGTH = 4000;

    /** 回执缓存容量。手机重连重发集中在短时间内，128 条足够覆盖。 */
    private static final int ACK_CACHE_SIZE = 128;

    private final ChatService chatService;
    private final DeviceWsProperties properties;
    private final DeviceSessionBindings bindings;

    /** deviceId|commandId → 已受理的回执。只缓存成功受理的，被拒的允许重试。 */
    private final Map<String, DeviceCommandAck> accepted = Collections.synchronizedMap(
            new LinkedHashMap<>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, DeviceCommandAck> eldest) {
                    return size() > ACK_CACHE_SIZE;
                }
            });

    @Autowired
    public DeviceCommandChatHandler(ChatService chatService, DeviceWsProperties properties,
                                    DeviceSessionBindings bindings) {
        this.chatService = chatService;
        this.properties = properties;
        this.bindings = bindings;
    }

    @Override
    public DeviceCommandAck handle(String deviceId, DeviceCommand command) {
        if (!properties.isCommandEnabled()) {
            log.info("设备指令被拒（开关关闭）: deviceId={}, commandId={}", deviceId, command.commandId());
            return DeviceCommandAck.rejected(command.commandId(),
                    "桌面端未开启手机指令（lingxi.device.command.enabled=false）");
        }
        String text = command.text() == null ? "" : command.text().trim();
        if (text.isEmpty()) {
            return DeviceCommandAck.rejected(command.commandId(), "指令内容为空");
        }
        if (text.length() > MAX_TEXT_LENGTH) {
            return DeviceCommandAck.rejected(command.commandId(),
                    "指令过长（上限 " + MAX_TEXT_LENGTH + " 字，实际 " + text.length() + "）");
        }

        String key = deviceId + "|" + command.commandId();
        DeviceCommandAck previous = accepted.get(key);
        if (previous != null) {
            log.info("设备指令重放，未重复执行: deviceId={}, commandId={}", deviceId, command.commandId());
            return previous.duplicate();
        }

        Long sessionId = command.sessionId() != null ? command.sessionId() : bindings.sessionOf(deviceId).orElse(null);
        try {
            Result<ChatAcceptanceVO> result = chatService.acceptCommand(ChatCommand.builder()
                    .input(text)
                    .sessionId(sessionId)
                    .build());
            if (result == null || result.getCode() <= 0 || result.getData() == null) {
                String reason = result == null || result.getErrMsg() == null
                        ? "桌面端未说明原因" : result.getErrMsg();
                log.warn("设备指令未被受理: deviceId={}, commandId={}, reason={}",
                        deviceId, command.commandId(), reason);
                return DeviceCommandAck.rejected(command.commandId(), reason);
            }
            ChatAcceptanceVO acceptedVo = result.getData();
            if (acceptedVo.getSessionId() != null) {
                // 绑定表与回推共用同一份：手机发进去的会话，结果必须推回同一台设备
                bindings.bind(deviceId, acceptedVo.getSessionId());
            }
            DeviceCommandAck ack = DeviceCommandAck.accepted(
                    command.commandId(), acceptedVo.getSessionId(), acceptedVo.getPendingId());
            accepted.put(key, ack);
            log.info("设备指令已受理: deviceId={}, commandId={}, sessionId={}, pendingId={}",
                    deviceId, command.commandId(), acceptedVo.getSessionId(), acceptedVo.getPendingId());
            return ack;
        } catch (RuntimeException failure) {
            // 受理失败不占幂等位：用户修好问题（例如先停掉正在跑的任务）应当能重发同一条
            log.warn("设备指令受理异常: deviceId={}, commandId={}", deviceId, command.commandId(), failure);
            return DeviceCommandAck.rejected(command.commandId(), "桌面端处理失败: " + failure.getMessage());
        }
    }
}
