package com.summit.dp.device.infrastructure.fake;

import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.NormalizedBounds;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.StopResult;
import com.summit.dp.device.application.model.UiElement;
import com.summit.dp.device.application.port.DeviceChannel;
import com.summit.dp.device.domain.Device;
import com.summit.dp.device.domain.DeviceCapability;
import com.summit.dp.device.domain.DeviceScreen;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 进程内假设备：一个可交互的"系统设置"界面。
 *
 * <p>它存在的意义是先跑通 observe → action → result 的完整闭环，再换真机。所以刻意做成
 * <b>有状态</b>的：点 WLAN 开关会真的改变状态、真的变帧指纹。否则测试只能验证"调用没抛异常"，
 * 验证不了"动作生效了"——那等于没测。</p>
 */
public class FakeDeviceChannel implements DeviceChannel {

    private static final String SETTINGS_PACKAGE = "com.android.settings";
    private static final String LAUNCHER_PACKAGE = "com.android.launcher";

    private final Device device;
    private final AtomicReference<ScreenState> state = new AtomicReference<>(ScreenState.of(SETTINGS_PACKAGE, false, ""));
    private final AtomicReference<Boolean> stopped = new AtomicReference<>(false);

    public FakeDeviceChannel(String deviceId) {
        this.device = new Device(
                deviceId,
                "0.1.0-fake",
                33,
                Set.of(DeviceCapability.NODE_TREE, DeviceCapability.GESTURES,
                        DeviceCapability.SET_TEXT, DeviceCapability.LAUNCH_APP),
                new DeviceScreen(1080, 2400, 2.75f, 0),
                System.currentTimeMillis());
    }

    @Override
    public Device device() {
        return device;
    }

    @Override
    public String foregroundPackage() {
        return state.get().packageName();
    }

    @Override
    public ObserveSnapshot observe(int maxNodes) {
        ScreenState current = state.get();
        List<UiElement> elements = buildElements(current);
        boolean truncated = elements.size() > maxNodes;
        List<UiElement> visible = truncated ? List.copyOf(elements.subList(0, maxNodes)) : List.copyOf(elements);
        return new ObserveSnapshot(
                device.deviceId(),
                current.frameHash(),
                current.packageName(),
                truncated,
                device.screen(),
                visible,
                null);
    }

    @Override
    public ActionOutcome perform(ActionRequest request) {
        if (Boolean.TRUE.equals(stopped.get())) {
            return ActionOutcome.failure(request.actionId(), "STOPPED", "设备已急停，需先恢复");
        }

        ScreenState current = state.get();
        if (request.expectFrameHash() != null && !request.expectFrameHash().equals(current.frameHash())) {
            // 画面已变：拒绝按旧坐标点击。这就是"看到旧画面点新按钮"的防线
            return ActionOutcome.failure(request.actionId(), "STALE_FRAME",
                    "画面已变化（期望 " + request.expectFrameHash() + "，实际 " + current.frameHash() + "），请重新观察");
        }

        ScreenState next;
        try {
            next = apply(request, current);
        } catch (IllegalArgumentException e) {
            return ActionOutcome.failure(request.actionId(), "INVALID_ARGUMENT", e.getMessage());
        } catch (RuntimeException e) {
            return ActionOutcome.failure(request.actionId(), "INTERNAL", e.getMessage());
        }

        if (next == null) {
            return ActionOutcome.failure(request.actionId(), "INVALID_ARGUMENT",
                    "假设备不支持的动作类型: " + request.kind());
        }

        state.set(next);
        boolean changed = !next.frameHash().equals(current.frameHash());
        return ActionOutcome.success(request.actionId(), 280, changed, next.frameHash());
    }

    @Override
    public StopResult stop() {
        // 假设备是进程内的，没有"送达不了"这回事，直接确认
        stopped.set(true);
        return StopResult.acknowledged(0);
    }

    /** 恢复到可操作状态，便于连续测试。 */
    public void resume() {
        stopped.set(false);
    }

    private ScreenState apply(ActionRequest request, ScreenState current) {
        return switch (request.kind()) {
            case "tap", "long_press" -> tapOn(pointOf(request.params()), current);
            case "set_text" -> current.withSearchText(String.valueOf(request.params().getOrDefault("text", "")));
            case "open_app" -> openApp(String.valueOf(request.params().getOrDefault("packageName", "")));
            case "back", "home" -> ScreenState.of(LAUNCHER_PACKAGE, current.wifiOn(), "");
            case "swipe" -> current.bump();   // 滑动手势在假设备里只产生"画面刷新"效果
            default -> null;
        };
    }

    /**
     * 按归一化坐标命中节点。刻意不看"文本"，逼着调用方像真设备一样用坐标/Algo 定位，
     * 否则假设备会比真机宽容，测试就会给出虚假的安全感。
     */
    private ScreenState tapOn(Point point, ScreenState current) {
        List<UiElement> elements = buildElements(current);
        for (UiElement element : elements) {
            NormalizedBounds bounds = element.bounds();
            boolean hit = point.x() >= bounds.x1() && point.x() <= bounds.x2()
                    && point.y() >= bounds.y1() && point.y() <= bounds.y2();
            if (!hit) {
                continue;
            }
            if ("switch".equals(element.role()) && "WLAN".equals(element.text())) {
                return current.withWifi(!current.wifiOn());
            }
            if ("input".equals(element.role())) {
                return current.bump();
            }
            return current.bump();
        }
        throw new IllegalArgumentException(
                "目标位置没有可交互元素：(" + point.x() + "," + point.y() + ")，请重新观察界面");
    }

    private ScreenState openApp(String packageName) {
        if (packageName == null || packageName.isBlank()) {
            throw new IllegalArgumentException("packageName 不能为空");
        }
        return switch (packageName) {
            case SETTINGS_PACKAGE -> ScreenState.of(SETTINGS_PACKAGE, state.get().wifiOn(), "");
            case LAUNCHER_PACKAGE -> ScreenState.of(LAUNCHER_PACKAGE, state.get().wifiOn(), "");
            default -> throw new IllegalArgumentException("假设备只内置了设置页与桌面，暂不支持: " + packageName);
        };
    }

    private List<UiElement> buildElements(ScreenState current) {
        List<UiElement> elements = new ArrayList<>();
        if (LAUNCHER_PACKAGE.equals(current.packageName())) {
            elements.add(new UiElement(0, "container", "桌面", null,
                    new NormalizedBounds(0, 0, 1000, 1000), false, true, false, null, 0));
            elements.add(new UiElement(1, "btn", "设置", null,
                    new NormalizedBounds(400, 800, 600, 880), true, true, false, null, 1));
            return elements;
        }
        elements.add(new UiElement(0, "text", "网络和互联网", null,
                new NormalizedBounds(37, 75, 556, 100), false, true, false, null, 1));
        elements.add(new UiElement(1, "switch", "WLAN", null,
                new NormalizedBounds(37, 125, 963, 158), true, true, false, current.wifiOn(), 2));
        elements.add(new UiElement(2, "input", current.searchText(), "搜索设置",
                new NormalizedBounds(111, 25, 889, 58), true, true, true, null, 1));
        elements.add(new UiElement(3, "text", "已连接网络", null,
                new NormalizedBounds(37, 200, 400, 230), false, true, false, null, 1));
        return elements;
    }

    private static Point pointOf(Map<String, Object> params) {
        Object raw = params.get("point");
        if (!(raw instanceof Map<?, ?> map)) {
            throw new IllegalArgumentException("tap 动作必须提供 point={x,y}");
        }
        return new Point(intOf(map.get("x")), intOf(map.get("y")));
    }

    private static int intOf(Object value) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        if (value instanceof String text) {
            return Integer.parseInt(text.trim());
        }
        throw new IllegalArgumentException("坐标必须是数字");
    }

    private record Point(int x, int y) {
    }

    /** 假设备的界面状态。帧指纹只由内容决定，不含修订号——否则"没变化"也会变指纹。 */
    private record ScreenState(String packageName, boolean wifiOn, String searchText, int revision) {

        static ScreenState of(String packageName, boolean wifiOn, String searchText) {
            return new ScreenState(packageName, wifiOn, searchText, 0);
        }

        ScreenState withWifi(boolean on) {
            return new ScreenState(packageName, on, searchText, revision + 1);
        }

        ScreenState withSearchText(String text) {
            return new ScreenState(packageName, wifiOn, text, revision + 1);
        }

        ScreenState bump() {
            return new ScreenState(packageName, wifiOn, searchText, revision + 1);
        }

        String frameHash() {
            return "fh-" + Integer.toHexString(Objects.hash(packageName, wifiOn, searchText));
        }
    }
}
