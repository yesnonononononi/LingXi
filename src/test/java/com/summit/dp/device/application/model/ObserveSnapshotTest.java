package com.summit.dp.device.application.model;

import com.summit.dp.device.domain.DeviceScreen;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 观察结果渲染成模型可读文本。
 *
 * <p>这段文字是模型唯一的输入：它看不到日志，也拿不到异常栈。所以三件事必须出现在文本里
 * ——节点为空时该怎么办、截图尺寸是多少、坐标空间是否一致。</p>
 */
class ObserveSnapshotTest {

    private static final DeviceScreen SCREEN = new DeviceScreen(1080, 2376, 3f, 0);

    private static ObserveSnapshot snapshot(List<UiElement> elements, DeviceScreenshot screenshot) {
        return new ObserveSnapshot("dev-1", "fh-1", "com.android.settings", false, SCREEN, elements, screenshot);
    }

    private static UiElement element() {
        return new UiElement(0, "switch", "WLAN", null,
                new NormalizedBounds(37, 125, 963, 158), true, true, false, true, 2);
    }

    @Test
    void 节点为空且没有截图时必须提示改用mode() {
        String text = snapshot(List.of(), null).toPromptText();

        assertTrue(text.contains("读不到节点"), text);
        assertTrue(text.contains("mode=\"shot\""), "不告诉模型怎么拿到图，它只会盲目重试同一个调用");
        assertFalse(text.contains("[警告]"), "没有截图时不该出现坐标空间告警");
    }

    @Test
    void 节点为空但有截图时要让模型按图片宽高换算() {
        DeviceScreenshot screenshot =
                new DeviceScreenshot(null, new byte[]{1, 2, 3}, "image/jpeg", 727, 1600, 1080, 2376);
        String text = snapshot(List.of(), screenshot).toPromptText();

        assertTrue(text.contains("已附带截图"), text);
        assertTrue(text.contains("727x1600"), "必须给出图片尺寸，否则模型无法把图上像素换算成归一化坐标");
        assertTrue(text.contains("0~1000"), text);
    }

    @Test
    void 只回了截图引用时要说明本端拿不到像素() {
        // 设备把图落在自己机器上只回引用时，本进程读不到那张图：不能让模型以为它看到了
        DeviceScreenshot screenshot =
                new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, 1600, 1080, 2376);
        String text = snapshot(List.of(), screenshot).toPromptText();

        assertTrue(text.contains("只回了截图引用"), text);
        assertTrue(text.contains("mode=\"both\""), text);
    }

    @Test
    void 截图没有图片宽高时必须说明无法按图换算() {
        DeviceScreenshot screenshot =
                new DeviceScreenshot(null, new byte[]{1, 2, 3}, "image/jpeg", null, null, null, null);
        String text = snapshot(List.of(element()), screenshot).toPromptText();

        assertTrue(text.contains("无法把图上的像素换算"), text);
        assertTrue(text.contains("按节点 bounds 定位"), text);
    }

    @Test
    void 坐标空间不一致必须显式告警() {
        DeviceScreenshot screenshot =
                new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, 1600, 1080, 2256);
        String text = snapshot(List.of(element()), screenshot).toPromptText();

        assertTrue(text.contains("[警告]"), "像素空间不一致时静默，会让模型一直点到偏移的位置上");
        assertTrue(text.contains("按节点 bounds 定位"), text);
    }

    @Test
    void 有节点无截图时提示可以加图而不是强制加图() {
        String text = snapshot(List.of(element()), null).toPromptText();

        assertTrue(text.contains("[提示]"), text);
        assertFalse(text.contains("[注意] 本屏读不到节点"), "有节点就不要误导模型去取图");
        assertTrue(text.contains("WLAN"));
    }
}
