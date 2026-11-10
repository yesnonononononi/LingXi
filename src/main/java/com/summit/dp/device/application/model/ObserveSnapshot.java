package com.summit.dp.device.application.model;

import com.summit.dp.device.domain.DeviceScreen;

import java.util.List;

/**
 * 一次观察的结果：节点树 + 帧指纹 + 截图。
 *
 * <p>frameHash 是动作的前置条件：agent 从"看到画面"到"发出动作"之间隔着模型推理和网络，
 * 画面很可能已经跳转，拿旧坐标点新界面轻则乱点、重则点到支付按钮。</p>
 *
 * <p><b>截图不是装饰</b>：ColorOS / Android 16 会把第三方应用的无障碍节点树截断到 1~2 个节点，
 * 此时节点列表几乎为空，截图是 agent 唯一能依据的事实。所以它和节点树一起进入模型上下文，
 * 而不是留给用户"手动看一眼"。</p>
 */
public record ObserveSnapshot(
        String deviceId,
        String frameHash,
        String focusedPackage,
        boolean truncated,
        DeviceScreen screen,
        List<UiElement> elements,
        DeviceScreenshot screenshot
) {

    public ObserveSnapshot {
        if (frameHash == null || frameHash.isBlank()) {
            throw new IllegalArgumentException("帧指纹不能为空，否则动作的前置校验无从谈起");
        }
        elements = elements == null ? List.of() : List.copyOf(elements);
    }

    /**
     * 帧指纹是否可用。
     *
     * <p>设备在节点树为空时会改用截图哈希做指纹（真机上第三方应用只有这样才测得出一页翻没翻）。
     * 连截图都没有时设备回 {@code noframe}——它是常量，含义是"不知道"，绝不是"画面没变"。
     * 这条提示必须进文本：模型看不到日志，它只会照着 changed=false 下结论。</p>
     */
    public boolean frameIdentityTrustworthy() {
        return frameHash != null && !frameHash.startsWith("noframe");
    }

    /** 节点树为空：真机上第三方应用的常态，此时必须提醒 agent 改用截图。 */
    public boolean emptyTree() {
        return elements.isEmpty();
    }

    /**
     * 渲染成给模型看的文本。刻意用紧凑单行格式：同一屏节点几十个，换行越多 token 越贵。
     *
     * <p>文本里必须同时出现"节点为空怎么办"和"坐标空间是否一致"两件事：
     * 模型看不到日志，它只能读到这段文字，缺一句就会走错方向。</p>
     */
    public String toPromptText() {
        StringBuilder builder = new StringBuilder();
        builder.append("device=").append(deviceId)
                .append(" package=").append(focusedPackage)
                .append(" frame=").append(frameHash)
                .append(" screen=").append(screen.width()).append('x').append(screen.height())
                .append(" rotation=").append(screen.rotation())
                .append(" truncated=").append(truncated);
        if (screenshot != null) {
            builder.append(" screenshot=").append(screenshot.sizeText());
        }
        builder.append('\n');
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
        builder.append(coordinateSpaceWarning());
        builder.append(pixelSizeWarning());
        if (!frameIdentityTrustworthy()) {
            builder.append("[警告] 本屏帧指纹不可用（读不到节点且没有截图）：动作前的画面校验与 changed 都不可信，")
                    .append("请改用 mode=\"both\" 观察两次并对比截图确认界面是否变化。\n");
        }
        if (emptyTree()) {
            builder.append(emptyTreeHint());
        } else if (screenshot == null) {
            builder.append("[提示] 本次只有节点没有截图；需要看图核对时可加 mode=\"both\"。\n");
        }
        return builder.toString();
    }

    /** 节点为空时的下一步指引：三种"有没有图"的情形处置完全不同，不能糊成一句话。 */
    private String emptyTreeHint() {
        StringBuilder hint = new StringBuilder("[注意] 本屏读不到节点（第三方应用的节点树常被系统截断）。");
        if (screenshot != null && screenshot.hasPixels()) {
            hint.append("已附带截图，请依据图上内容判断；点击时把图上的像素坐标按图片宽高换算成 0~1000 归一化坐标。\n");
        } else if (screenshot != null) {
            // 只有引用没有字节：本进程读不到那张图，别让模型以为它看到了
            hint.append("设备只回了截图引用（").append(screenshot.shotRef())
                    .append("），本端拿不到像素；请改用 mode=\"both\" 让设备内联回传图片。\n");
        } else {
            hint.append("请改用 device_observe(mode=\"shot\" 或 \"both\") 重新观察以取得截图。\n");
        }
        return hint.toString();
    }

    /**
     * 截图尺寸告警：没有图片宽高时，图上像素换算不出归一化坐标。
     *
     * <p>协议允许只给图不给尺寸（"让我看一眼"是合法诉求），但此时只能按节点定位，
     * 这一点必须写进文本——否则模型会拿图上像素当坐标硬算，落点全凭运气。</p>
     */
    private String pixelSizeWarning() {
        if (screenshot == null || screenshot.hasImageSize()) {
            return "";
        }
        return "[警告] 截图没有提供图片宽高，无法把图上的像素换算成归一化坐标；请只按节点 bounds 定位。\n";
    }

    /**
     * 坐标空间告警：原始像素与屏幕尺寸不一致时必须说出来。
     *
     * <p>不加这一行，偏移会被静默带进每一次点击，而模型只会看到"点了没反应"。</p>
     */
    private String coordinateSpaceWarning() {
        if (screenshot == null) {
            return "";
        }
        if (screenshot.coordinateSpace(screen) == DeviceScreenshot.CoordinateSpace.MISMATCH) {
            return "[警告] 截图原始像素 " + screenshot.rawWidth() + "x" + screenshot.rawHeight()
                    + " 与屏幕 " + screen.width() + "x" + screen.height()
                    + " 不是同一坐标空间，按图换算的落点可能整体偏移；优先按节点 bounds 定位。\n";
        }
        return "";
    }
}
