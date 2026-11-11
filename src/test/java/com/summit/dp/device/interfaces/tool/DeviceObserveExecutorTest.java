package com.summit.dp.device.interfaces.tool;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.device.application.DeviceRegistry;
import com.summit.dp.device.application.DeviceToolService;
import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.DeviceReply;
import com.summit.dp.device.application.model.DeviceScreenshot;
import com.summit.dp.device.application.model.NormalizedBounds;
import com.summit.dp.device.application.model.ObserveRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.StopResult;
import com.summit.dp.device.application.model.UiElement;
import com.summit.dp.device.application.port.DeviceChannel;
import com.summit.dp.device.application.port.ObserveImageAttacher;
import com.summit.dp.device.domain.ActionLedger;
import com.summit.dp.device.domain.DangerPolicy;
import com.summit.dp.device.domain.Device;
import com.summit.dp.device.domain.DeviceCapability;
import com.summit.dp.device.domain.DeviceScreen;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * device_observe 工具层：模式透传、截图注入、以及"图没进来时必须说实话"。
 *
 * <p>为什么单独测这一层：模型能读到的是这段文本和注入了哪些图。这里少一句话，
 * 模型就会对着一张不存在的图推理，然后在一个空节点界面上瞎点。</p>
 */
class DeviceObserveExecutorTest {

    private static final DeviceScreen SCREEN = new DeviceScreen(1080, 2376, 3f, 0);

    private final ObjectMapper mapper = new ObjectMapper();

    /** 只产出一张截图的假通道：真机第三方应用就是这个样子（节点为空、有图）。 */
    private static final class ShotChannel implements DeviceChannel {

        private final Device device = new Device("dev-shot", "0.1.0", 36,
                Set.of(DeviceCapability.NODE_TREE, DeviceCapability.GESTURES, DeviceCapability.SCREENSHOT),
                SCREEN, System.currentTimeMillis());
        private final AtomicReference<ObserveRequest> lastRequest = new AtomicReference<>();
        private final DeviceScreenshot screenshot;

        ShotChannel(DeviceScreenshot screenshot) {
            this.screenshot = screenshot;
        }

        @Override
        public boolean pushReply(DeviceReply reply) {
            // 观察链路不涉及回推
            return true;
        }

        @Override
        public Device device() {
            return device;
        }

        @Override
        public ObserveSnapshot observe(ObserveRequest request) {
            lastRequest.set(request);
            return new ObserveSnapshot("dev-shot", "fh-shot", "com.android.settings", false, SCREEN,
                    List.of(new UiElement(0, "text", "设置", null,
                            new NormalizedBounds(10, 10, 20, 20), false, true, false, null, 1)),
                    request.mode().wantsScreenshot() ? screenshot : null);
        }

        @Override
        public ActionOutcome perform(ActionRequest request) {
            return ActionOutcome.success(request.actionId(), 0, false, "fh-shot");
        }

        @Override
        public StopResult stop() {
            return StopResult.acknowledged(0);
        }

        @Override
        public String foregroundPackage() {
            return "com.android.settings";
        }
    }

    private static DeviceScreenshot shot() {
        return new DeviceScreenshot(null, new byte[]{(byte) 0xFF, (byte) 0xD8, 1, 2, 3},
                "image/jpeg", 727, 1600, 1080, 2376);
    }

    private DeviceToolService service(DeviceChannel channel) {
        DeviceRegistry registry = new DeviceRegistry();
        registry.register(channel);
        return new DeviceToolService(registry, new DangerPolicy(), new ActionLedger());
    }

    private ToolExecution execution(String args) {
        return ToolExecution.builder().args(args).attributes(Map.of()).build();
    }

    @Test
    void 模式参数透传到设备请求() {
        ShotChannel channel = new ShotChannel(shot());
        DeviceObserveExecutor executor = new DeviceObserveExecutor(service(channel), mapper);

        executor.execute(execution("{\"mode\":\"both\",\"maxNodes\":30}"));

        ObserveRequest request = channel.lastRequest.get();
        assertNotNull(request);
        assertEquals("both", request.mode().wire());
        assertEquals(30, request.maxNodes());
    }

    @Test
    void 缺省模式只取节点() {
        ShotChannel channel = new ShotChannel(shot());
        DeviceObserveExecutor executor = new DeviceObserveExecutor(service(channel), mapper);

        executor.execute(execution("{}"));

        assertEquals("nodes", channel.lastRequest.get().mode().wire(),
                "默认模式必须是便宜的 nodes，不能默认带图把上下文烧掉");
    }

    @Test
    void 未知模式给出可读错误而不是静默兜底() {
        ShotChannel channel = new ShotChannel(shot());
        DeviceObserveExecutor executor = new DeviceObserveExecutor(service(channel), mapper);

        ToolExecuteResult result = executor.execute(execution("{\"mode\":\"video\"}"));

        assertEquals(false, result.isSuccess());
        assertTrue(result.getToolOutput().contains("nodes / shot / both"), result.getToolOutput());
        assertNull(channel.lastRequest.get(), "参数非法时不该真的去打扰设备");
    }

    @Test
    void 截图能随回执交给图片注入链路() {
        ShotChannel channel = new ShotChannel(shot());
        AtomicReference<DeviceScreenshot> attached = new AtomicReference<>();
        ObserveImageAttacher attacher = (attributes, screenshot, label) -> {
            attached.set(screenshot);
            return Optional.of(Map.of("imageId", "abc123", "ext", "jpg", "mimeType", "image/jpeg",
                    "width", 727, "height", 1600, "path", label));
        };
        DeviceObserveExecutor executor = new DeviceObserveExecutor(service(channel), mapper, attacher);

        ToolExecuteResult result = executor.execute(execution("{\"mode\":\"both\"}"));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals(5, attached.get().image().length, "截图字节必须原样交给注入链路");
        Map<String, Object> metadata = result.getToolMetaData();
        assertNotNull(metadata, "没有元数据，注入拦截器就不会把图送进上下文");
        assertEquals("abc123", metadata.get("imageId"));
        assertTrue(result.getToolOutput().contains("下一轮作为图像消息"), result.getToolOutput());
    }

    @Test
    void 无法注入图片时必须明说而不是假装看到了() {
        ShotChannel channel = new ShotChannel(shot());
        // 没有视觉模型/会话时 attach 返回空
        DeviceObserveExecutor executor = new DeviceObserveExecutor(service(channel), mapper,
                (attributes, screenshot, label) -> Optional.empty());

        ToolExecuteResult result = executor.execute(execution("{\"mode\":\"both\"}"));

        assertTrue(result.isSuccess());
        assertNull(result.getToolMetaData());
        assertTrue(result.getToolOutput().contains("无法把图片送入你的上下文"), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("不要臆测画面内容"), result.getToolOutput());
    }
}
