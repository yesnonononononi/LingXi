package com.summit.dp.tools.application.vo;

import lombok.Builder;

@Builder
public record ToolVO(
        String name,
        String description,
        boolean readOnly
) {
}
