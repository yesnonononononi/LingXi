package com.summit.dp.device.application;

import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.port.DeviceUnavailableException;
import com.summit.dp.device.domain.ActionLedger;
import com.summit.dp.device.domain.DangerPolicy;
import com.summit.dp.device.infrastructure.fake.FakeDeviceChannel;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 假设备闭环：观察 → 动作 → 再观察，验证动作真的改变了界面状态。
 *
 * <p>断言一律落在"可观察的外部事实"上（文本里的 frame、checked 标记），而不是内部字段，
 * 这样换成真实通道时这些用例依然成立。</p>
 */
class DeviceToolServiceTest {

    private static final Pattern FRAME = Pattern.compile("frame=(\\S+)");
    private static final Pattern DANGER_ID = Pattern.compile("dangerId=(\\S+)");
    private static final Map<String, Object> WLAN_SWITCH_POINT =
            Map.of("point", Map.of("x", 500, "y", 141));

    private FakeDeviceChannel channel;
    private DeviceToolService service;

    @BeforeEach
    void setUp() {
        channel = new FakeDeviceChannel("dev-test");
        DeviceRegistry registry = new DeviceRegistry();
        registry.register(channel);
        service = new DeviceToolService(registry, new DangerPolicy(), new ActionLedger());
    }

    @Test
    void 观察能拿到节点与帧指纹() {
        String text = service.observe(null, 80);

        assertTrue(text.contains("device=dev-test"));
        assertTrue(text.contains("package=com.android.settings"));
        assertTrue(FRAME.matcher(text).find(), "没有帧指纹，后续动作就无从校验画面是否变化");
        assertTrue(text.contains("WLAN"));
        assertTrue(text.lines().anyMatch(line -> line.contains("可点击") || line.contains("clickable")));
    }

    @Test
    void 点击开关会真的改变界面状态() {
        String before = service.observe(null, 80);
        String frame = frameOf(before);
        assertTrue(wlanLine(before).contains("checked") == false, "初始状态 WLAN 应为关闭");

        String outcome = service.act(null, tap("a-1", WLAN_SWITCH_POINT, frame, "WLAN"));
        assertTrue(outcome.startsWith("ok"), "动作应成功，实际=" + outcome);

        String after = service.observe(null, 80);
        assertTrue(wlanLine(after).contains("checked"), "点过开关之后 WLAN 必须变成开启");
        assertTrue(frameOf(after) != null && !frameOf(after).equals(frame), "界面变了，帧指纹必须跟着变");
    }

    @Test
    void 帧指纹不匹配必须拒绝执行() {
        service.observe(null, 80);

        String outcome = service.act(null, tap("a-2", WLAN_SWITCH_POINT, "fh-stale", "WLAN"));

        assertTrue(outcome.contains("STALE_FRAME"), "画面变了还按旧坐标点，等于随机点击");
        assertTrue(wlanLine(service.observe(null, 80)).contains("checked") == false,
                "被拒绝的动作不允许产生副作用");
    }

    @Test
    void 同一动作重放不会执行第二次() {
        String frame = frameOf(service.observe(null, 80));
        service.act(null, tap("a-3", WLAN_SWITCH_POINT, frame, "WLAN"));

        String replay = service.act(null, tap("a-3", WLAN_SWITCH_POINT, frame, "WLAN"));

        assertTrue(replay.contains("已执行过"), "重放必须被台账拦下，实际=" + replay);
        assertTrue(service.observe(null, 80).contains("WLAN"));
    }

    @Test
    void 危险动作先挂起_确认后才执行() {
        String frame = frameOf(service.observe(null, 80));

        String pending = service.act(null, tap("a-4", WLAN_SWITCH_POINT, frame, "确认支付"));
        assertTrue(pending.contains("需要用户确认"), "命中危险词时必须先问，实际=" + pending);
        assertTrue(wlanLine(service.observe(null, 80)).contains("checked") == false,
                "待确认期间不允许执行");

        String confirmed = service.confirm(dangerIdOf(pending), true);
        assertTrue(confirmed.startsWith("ok"), "用户同意后应执行，实际=" + confirmed);
        assertTrue(wlanLine(service.observe(null, 80)).contains("checked"), "同意后动作必须真的生效");
    }

    @Test
    void 危险动作被拒绝则不执行() {
        String frame = frameOf(service.observe(null, 80));
        String pending = service.act(null, tap("a-5", WLAN_SWITCH_POINT, frame, "转账"));

        String rejected = service.confirm(dangerIdOf(pending), false);

        assertTrue(rejected.contains("未执行"), "拒绝后必须明确告知未执行，实际=" + rejected);
        assertTrue(wlanLine(service.observe(null, 80)).contains("checked") == false);
    }

    @Test
    void 二次确认同一个dangerId不会重复执行() {
        String frame = frameOf(service.observe(null, 80));
        String pending = service.act(null, tap("a-6", WLAN_SWITCH_POINT, frame, "支付"));
        String dangerId = dangerIdOf(pending);

        service.confirm(dangerId, true);
        String second = service.confirm(dangerId, true);

        assertTrue(second.contains("找不到待确认动作"), "同一个确认只能生效一次，实际=" + second);
    }

    @Test
    void 急停之后动作会被拒绝() {
        String frame = frameOf(service.observe(null, 80));
        service.stop(null);

        String outcome = service.act(null, tap("a-7", WLAN_SWITCH_POINT, frame, "WLAN"));

        assertTrue(outcome.contains("STOPPED"), "急停后必须拒绝动作，实际=" + outcome);
    }

    @Test
    void 没有设备时给出可读原因() {
        DeviceToolService emptyService = new DeviceToolService(
                new DeviceRegistry(), new DangerPolicy(), new ActionLedger());

        DeviceUnavailableException exception = assertThrows(DeviceUnavailableException.class,
                () -> emptyService.observe(null, 80));
        assertTrue(exception.getMessage().contains("没有已连接的设备"));
    }

    private static ActionRequest tap(String actionId, Map<String, Object> params, String frame, String targetText) {
        return new ActionRequest(actionId, "tap", params, frame, targetText);
    }

    private static String frameOf(String observeText) {
        Matcher matcher = FRAME.matcher(observeText);
        assertTrue(matcher.find(), "观察结果里没有 frame=，实际=" + observeText);
        return matcher.group(1);
    }

    private static String dangerIdOf(String pendingText) {
        Matcher matcher = DANGER_ID.matcher(pendingText);
        assertTrue(matcher.find(), "待确认提示里没有 dangerId=，实际=" + pendingText);
        return matcher.group(1);
    }

    private static String wlanLine(String observeText) {
        return observeText.lines()
                .filter(line -> line.contains("WLAN"))
                .findFirst()
                .orElse("");
    }
}
