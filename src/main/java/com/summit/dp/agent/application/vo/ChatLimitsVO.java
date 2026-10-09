package com.summit.dp.agent.application.vo;

/** 界面读取领域限制，避免前后端各自维护上限。 */
public record ChatLimitsVO(int maxImages) {
}
