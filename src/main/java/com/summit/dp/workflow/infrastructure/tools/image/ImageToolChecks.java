package com.summit.dp.workflow.infrastructure.tools.image;

import com.summit.dp.shared.exception.ClientException;

/** 图片工具链通用的前置条件校验：失败抛 {@link ClientException}，由工具执行层转成失败回执。 */
final class ImageToolChecks {

    private ImageToolChecks() {
    }

    /** 条件成立即失败（注意不是「要求成立」）：抛出带用户文案的 {@link ClientException}。 */
    static void rejectIf(boolean violated, String message) {
        if (violated) throw new ClientException(message);
    }
}
