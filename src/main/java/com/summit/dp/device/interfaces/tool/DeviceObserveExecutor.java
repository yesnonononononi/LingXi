package com.summit.dp.device.interfaces.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.application.model.DeviceScreenshot;
import com.summit.dp.device.application.model.ObserveRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.application.port.ObserveImageAttacher;
import com.summit.dp.device.interfaces.tool.arguments.DeviceObserveArguments;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

import java.util.Map;
import java.util.Optional;

/** device_observe：让 agent 看一眼当前界面（节点 / 截图 / 两者）。 */
@Slf4j
public class DeviceObserveExecutor implements ToolExecutor {

    private static final int DEFAULT_MAX_NODES = 80;

    private final DeviceToolService deviceToolService;
    private final ObjectMapper objectMapper;

    /** 可空：图片注入依赖会话与视觉模型，缺失时观察仍应工作，只是看不到图。 */
    private final ObserveImageAttacher imageAttacher;

    public DeviceObserveExecutor(DeviceToolService deviceToolService, ObjectMapper objectMapper) {
        this(deviceToolService, objectMapper, null);
    }

    public DeviceObserveExecutor(DeviceToolService deviceToolService, ObjectMapper objectMapper,
                                 ObserveImageAttacher imageAttacher) {
        this.deviceToolService = deviceToolService;
        this.objectMapper = objectMapper;
        this.imageAttacher = imageAttacher;
    }

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            String args = toolExecution == null ? null : toolExecution.getArgs();
            DeviceObserveArguments arguments = (args == null || args.isBlank())
                    ? new DeviceObserveArguments(null, null, null)
                    : objectMapper.readValue(args, DeviceObserveArguments.class);

            int maxNodes = arguments.maxNodes() == null ? DEFAULT_MAX_NODES : arguments.maxNodes();
            // 上限校验交给请求对象：那里是唯一口径，避免两处各写一份范围判断后漂移
            ObserveRequest request = new ObserveRequest(maxNodes, arguments.resolveMode());

            ObserveSnapshot snapshot = deviceToolService.observe(arguments.deviceId(), request);
            Optional<Map<String, Object>> metadata = attachScreenshot(toolExecution, snapshot);
            return ToolExecuteResult.success(
                    renderText(snapshot, metadata.isPresent()),
                    com.summit.core.tool.ToolResultType.NORMAL,
                    metadata.orElse(null));
        } catch (DeviceUnavailableException e) {
            return ToolExecuteResult.err(e.getMessage());
        } catch (IllegalArgumentException e) {
            // 参数问题不是设备故障，回执要说清楚是"你的参数不对"，而不是"设备连不上"
            log.info("device_observe 参数被拒绝: {}", e.getMessage());
            return ToolExecuteResult.err("device_observe 参数非法: " + e.getMessage());
        } catch (Exception e) {
            log.warn("device_observe 失败: reason={}", e.getMessage());
            return ToolExecuteResult.err("device_observe 执行失败: " + e.getMessage());
        }
    }

    /**
     * 把截图交给图片缓存，供下一轮注入模型上下文。
     *
     * <p>失败不抛：观察本身已经成功，节点与尺寸都是有效信息；但要在回执里如实写明
     * "图没有进入上下文"，否则模型会以为自己看到了画面。</p>
     */
    private Optional<Map<String, Object>> attachScreenshot(ToolExecution toolExecution, ObserveSnapshot snapshot) {
        DeviceScreenshot screenshot = snapshot.screenshot();
        if (imageAttacher == null || screenshot == null || !screenshot.hasPixels()) {
            return Optional.empty();
        }
        Map<String, Object> attributes = toolExecution == null || toolExecution.getAttributes() == null
                ? Map.of()
                : toolExecution.getAttributes();
        try {
            return imageAttacher.attach(
                    attributes, screenshot, "device:" + snapshot.focusedPackage());
        } catch (RuntimeException failed) {
            log.warn("设备截图注入失败: package={}, reason={}", snapshot.focusedPackage(), failed.getMessage());
            return Optional.empty();
        }
    }

    /** 文本 = 快照渲染 + 一句"这张图到底进来没有"，避免模型对着一张不存在的图推理。 */
    private String renderText(ObserveSnapshot snapshot, boolean imageInjected) {
        StringBuilder text = new StringBuilder(snapshot.toPromptText());
        if (snapshot.screenshot() != null && snapshot.screenshot().hasPixels()) {
            text.append(imageInjected
                    ? "[截图] 图片将在下一轮作为图像消息提供，尺寸见上行 screenshot= 字段。\n"
                    : "[截图] 已截到图，但当前无法把图片送入你的上下文（缺视觉模型或会话标识），"
                            + "请只依据节点与已有信息判断，不要臆测画面内容。\n");
        }
        return text.toString();
    }
}
