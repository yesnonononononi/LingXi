package com.summit.dp.device.application;

import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.DeviceReply;
import com.summit.dp.device.application.model.DeviceScreenshot;
import com.summit.dp.device.application.model.ObserveRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.StopResult;
import com.summit.dp.device.application.model.UiElement;
import com.summit.dp.device.application.port.DeviceChannel;
import com.summit.dp.device.domain.ActionLedger;
import com.summit.dp.device.domain.DangerPolicy;
import com.summit.dp.device.domain.Device;
import com.summit.dp.device.domain.DeviceCapability;
import com.summit.dp.device.domain.DeviceScreen;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「看图 → 点图上像素」的换算：本端负责把截图像素翻译成归一化坐标。
 *
 * <p>为什么不让模型自己算：截图 727x1600、图上 (363,800) → 归一化 (499,500)。
 * 两次除法交给模型，错一次就是点偏，而这是确定性算术，本端一行代码就能钉住。</p>
 */
class DeviceImagePointTest {

    private static final DeviceScreen SCREEN = new DeviceScreen(1080, 2376, 3f, 0);

    /** 记录收到的动作参数，用来断言换算结果真的被下发。 */
    private static final class RecordingChannel implements DeviceChannel {

        private final Device device = new Device("dev-img", "0.1.0", 36,
                Set.of(DeviceCapability.NODE_TREE, DeviceCapability.GESTURES, DeviceCapability.SCREENSHOT),
                SCREEN, System.currentTimeMillis());
        private final List<ActionRequest> requests = new ArrayList<>();
        private ObserveSnapshot nextSnapshot = snapshotWith(
                new DeviceScreenshot(null, new byte[]{1, 2, 3}, "image/jpeg", 727, 1600, 1080, 2376));

        private static ObserveSnapshot snapshotWith(DeviceScreenshot shot) {
            return new ObserveSnapshot("dev-img", "fh-img", "com.android.settings", false, SCREEN,
                    List.<UiElement>of(), shot);
        }

        void willReturn(DeviceScreenshot shot) {
            nextSnapshot = snapshotWith(shot);
            // 帧指纹跟着变，模拟"换了一张画面"
            nextSnapshot = new ObserveSnapshot("dev-img", "fh-img-2", "com.android.settings", false, SCREEN,
                    List.<UiElement>of(), shot);
        }

        @Override
        public boolean pushReply(DeviceReply reply) {
            // 这些用例只关心观察/动作，回推不参与断言
            return true;
        }

        @Override
        public Device device() {
            return device;
        }

        @Override
        public ObserveSnapshot observe(ObserveRequest request) {
            return nextSnapshot;
        }

        @Override
        public ActionOutcome perform(ActionRequest request) {
            requests.add(request);
            return ActionOutcome.success(request.actionId(), 60, true, "fh-img");
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
        return new DeviceScreenshot(null, new byte[]{1, 2, 3}, "image/jpeg", 727, 1600, 1080, 2376);
    }

    private DeviceToolService service(DeviceChannel channel) {
        DeviceRegistry registry = new DeviceRegistry();
        registry.register(channel);
        return new DeviceToolService(registry, new DangerPolicy(), new ActionLedger());
    }

    private static ActionRequest tapAtImagePoint(String actionId, int x, int y, String frame) {
        return new ActionRequest(actionId, "tap", Map.of("imagePoint", Map.of("x", x, "y", y)), frame, null);
    }

    private static int normalizedX(ActionRequest request) {
        Object point = request.params().get("point");
        return ((Number) ((Map<?, ?>) point).get("x")).intValue();
    }

    private static int normalizedY(ActionRequest request) {
        Object point = request.params().get("point");
        return ((Number) ((Map<?, ?>) point).get("y")).intValue();
    }

    @Test
    void 图上像素按截图宽高换算成归一化坐标() {
        RecordingChannel channel = new RecordingChannel();
        DeviceToolService service = service(channel);
        service.observe(null, new ObserveRequest(80, com.summit.dp.device.application.model.ObserveMode.BOTH));

        String outcome = service.act(null, tapAtImagePoint("a-img-1", 363, 800, "fh-img"));

        assertTrue(outcome.startsWith("ok"), outcome);
        ActionRequest sent = channel.requests.get(0);
        assertEquals(499, normalizedX(sent), "363/727*1000 ≈ 499");
        assertEquals(500, normalizedY(sent), "800/1600*1000 = 500");
        assertTrue(sent.params().get("imagePoint") == null, "换算完就该换成 point，不能两个坐标一起下发");
    }

    @Test
    void 图上越界像素被夹到边界而不是溢出() {
        RecordingChannel channel = new RecordingChannel();
        DeviceToolService service = service(channel);
        service.observe(null, new ObserveRequest(80, com.summit.dp.device.application.model.ObserveMode.BOTH));

        service.act(null, tapAtImagePoint("a-img-2", 5000, -20, "fh-img"));

        ActionRequest sent = channel.requests.get(0);
        assertEquals(1000, normalizedX(sent));
        assertEquals(0, normalizedY(sent));
    }

    @Test
    void 没有截图的坐标分母时拒绝并说明先观察() {
        RecordingChannel channel = new RecordingChannel();
        DeviceToolService service = service(channel);

        String outcome = service.act(null, tapAtImagePoint("a-img-3", 10, 10, "fh-img"));

        assertTrue(outcome.contains("坐标无法确定"), outcome);
        assertTrue(outcome.contains("mode=\"both\""), "必须告诉 agent 下一步做什么，否则它只会重试");
        assertTrue(channel.requests.isEmpty(), "坐标无法确定时不能真的下发手势");
    }

    @Test
    void point与imagePoint同时给时拒绝而不是猜一个() {
        RecordingChannel channel = new RecordingChannel();
        DeviceToolService service = service(channel);
        service.observe(null, new ObserveRequest(80, com.summit.dp.device.application.model.ObserveMode.BOTH));

        String outcome = service.act(null, new ActionRequest("a-img-4", "tap",
                Map.of("point", Map.of("x", 10, "y", 10), "imagePoint", Map.of("x", 20, "y", 20)),
                "fh-img", null));

        assertTrue(outcome.contains("只能给一个"), outcome);
        assertTrue(channel.requests.isEmpty());
    }

    @Test
    void 滑动不支持图上像素坐标时给出明确原因() {
        RecordingChannel channel = new RecordingChannel();
        DeviceToolService service = service(channel);
        service.observe(null, new ObserveRequest(80, com.summit.dp.device.application.model.ObserveMode.BOTH));

        String outcome = service.act(null, new ActionRequest("a-img-5", "swipe",
                Map.of("imagePoint", Map.of("x", 10, "y", 10)), "fh-img", null));

        assertTrue(outcome.contains("只支持 tap / long_press"), outcome);
    }

    @Test
    void 断线会清掉截图分母避免用旧尺寸换算() {
        RecordingChannel channel = new RecordingChannel();
        DeviceToolService service = service(channel);
        service.observe(null, new ObserveRequest(80, com.summit.dp.device.application.model.ObserveMode.BOTH));

        service.onDisconnected("dev-img");
        DeviceRegistry registry = new DeviceRegistry();
        registry.register(channel);
        DeviceToolService reconnected = new DeviceToolService(registry, new DangerPolicy(), new ActionLedger());

        String outcome = reconnected.act(null, tapAtImagePoint("a-img-6", 10, 10, "fh-img"));

        assertTrue(outcome.contains("坐标无法确定"), "新会话没有截图，不该沿用上一次的分母");
    }
}
