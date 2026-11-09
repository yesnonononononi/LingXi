package com.summit.dp.device.application.model;

import com.summit.dp.device.domain.DeviceScreen;

import java.util.List;

/**
 * 一次观察的结果：节点树 + 帧指纹 + 截图引用。
 *
 * <p>frameHash 是动作的前置条件：agent 从"看到画面"到"发出动作"之间隔着模型推理和网络，
 * 画面很可能已经跳转，拿旧坐标点新界面轻则乱点、重则点到支付按钮。</p>
 */
public record ObserveSnapshot(
        String deviceId,
        String frameHash,
        String focusedPackage,
        boolean truncated,
        DeviceScreen screen,
        List<UiElement> elements,
        String screenshotRef
) {

    public ObserveSnapshot {
        if (frameHash == null || frameHash.isBlank()) {
            throw new IllegalArgumentException("帧指纹不能为空，否则动作的前置校验无从谈起");
        }
        elements = elements == null ? List.of() : List.copyOf(elements);
    }

    /**
     * 渲染成给模型看的文本。刻意用紧凑单行格式：同一屏节点几十个，换行越多 token 越贵。
     */
    public String toPromptText() {
        StringBuilder builder = new StringBuilder();
        builder.append("device=").append(deviceId)
                .append(" package=").append(focusedPackage)
                .append(" frame=").append(frameHash)
                .append(" screen=").append(screen.width()).append('x').append(screen.height())
                .append(" rotation=").append(screen.rotation())
                .append(" truncated=").append(truncated)
                .append('\n');
        for (UiElement element : elements) {
            builder.append('[').append(element.idx()).append("] ")
                    .append(element.role());
            if (element.text() != null && !element.text().isBlank()) {
                builder.append(" \"").append(element.text()).append('"');
            }
            if (element.hint() != null && !element.hint().isBlank()) {
                builder.append(" hint=\"").append(element.hint()).append('"');
            }
            builder.append(" b=").append(element.bounds().x1()).append(',').append(element.bounds().y1())
                    .append(',').append(element.bounds().x2()).append(',').append(element.bounds().y2());
            if (element.clickable()) {
                builder.append(" clickable");
            }
            if (element.editable()) {
                builder.append(" editable");
            }
            if (Boolean.TRUE.equals(element.checked())) {
                builder.append(" checked");
            }
            if (!element.enabled()) {
                builder.append(" disabled");
            }
            builder.append('\n');
        }
        if (truncated) {
            builder.append("[注意] 节点已截断，界面上还有未列出的元素，不要断言「界面没有某个按钮」。\n");
        }
        if (screenshotRef != null && !screenshotRef.isBlank()) {
            builder.append("screenshotRef=").append(screenshotRef).append('\n');
        }
        return builder.toString();
    }
}
