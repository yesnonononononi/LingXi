package com.summit.dp.device.application.model;

import com.summit.dp.device.domain.DeviceScreen;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 截图载荷的校验与坐标空间判定。
 *
 * <p>三条断言对应三种真实故障：图没有尺寸（换算不出来）、原始像素与屏幕不一致
 * （点击整体偏移）、把"设备没上报"当成"没问题"（偏移被静默放过）。</p>
 */
class DeviceScreenshotTest {

    private static final DeviceScreen SCREEN = new DeviceScreen(1080, 2376, 3f, 0);

    @Test
    void 引用与内联必须二选一() {
        assertThrows(IllegalArgumentException.class, () -> new DeviceScreenshot(null, null, null, null, null, null, null));
        assertThrows(IllegalArgumentException.class,
                () -> new DeviceScreenshot("trace/a.jpg", new byte[]{1, 2}, "image/jpeg", null, null, null, null));
    }

    @Test
    void 图片宽高必须成对出现() {
        // 只给宽度：分母缺失，像素点无法换算成归一化坐标，宁可当场失败
        assertThrows(IllegalArgumentException.class,
                () -> new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, null, null, null));
        assertThrows(IllegalArgumentException.class,
                () -> new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", null, 1600, null, null));
    }

    @Test
    void 原始像素必须成对出现且为正() {
        assertThrows(IllegalArgumentException.class,
                () -> new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, 1600, 1080, null));
        assertThrows(IllegalArgumentException.class,
                () -> new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, 1600, 0, 2376));
    }

    @Test
    void 内联截图超过上限直接拒绝() {
        byte[] tooBig = new byte[DeviceScreenshot.MAX_INLINE_BYTES + 1];
        assertThrows(IllegalArgumentException.class,
                () -> new DeviceScreenshot(null, tooBig, "image/jpeg", 10, 10, null, null));
    }

    @Test
    void 原始像素与屏幕一致时为MATCH_旋转互换也算一致() {
        DeviceScreenshot same = new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, 1600, 1080, 2376);
        assertEquals(DeviceScreenshot.CoordinateSpace.MATCH, same.coordinateSpace(SCREEN));

        // 旋转 90° 时屏幕宽高互换是正常现象，误报会让模型放弃按图定位
        DeviceScreenshot rotated = new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 1080, 1600, 2376, 1080);
        assertEquals(DeviceScreenshot.CoordinateSpace.MATCH, rotated.coordinateSpace(SCREEN));
    }

    @Test
    void 少掉导航栏的像素空间必须判为MISMATCH() {
        // 真机现场：screen 报 2376，截图来自 2256 的"应用可用区"，差 120px
        DeviceScreenshot mismatch =
                new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, 1600, 1080, 2256);
        assertEquals(DeviceScreenshot.CoordinateSpace.MISMATCH, mismatch.coordinateSpace(SCREEN));
    }

    @Test
    void 老设备没上报原始像素时是UNKNOWN而不是MATCH() {
        // 把"不知道"当"没问题"，等于让偏移静默通过
        DeviceScreenshot legacy = new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, 1600, null, null);
        assertEquals(DeviceScreenshot.CoordinateSpace.UNKNOWN, legacy.coordinateSpace(SCREEN));
    }

    @Test
    void 字节数组不留可变引用() {
        byte[] payload = {1, 2, 3};
        DeviceScreenshot screenshot = new DeviceScreenshot(null, payload, "image/jpeg", 10, 10, null, null);
        payload[0] = 9;
        assertEquals(1, screenshot.image()[0], "构造后外部改数组不应影响领域对象");
        screenshot.image()[0] = 7;
        assertEquals(1, screenshot.image()[0], "取出的数组也不该是内部那份");
    }

    @Test
    void 尺寸摘要包含模型换算所需的全部字段() {
        DeviceScreenshot screenshot =
                new DeviceScreenshot("trace/a.jpg", null, "image/jpeg", 727, 1600, 1080, 2376);
        String text = screenshot.sizeText();
        assertTrue(text.contains("727x1600"), text);
        assertTrue(text.contains("raw=1080x2376"), text);
        assertTrue(text.contains("ref=trace/a.jpg"), text);
    }
}
