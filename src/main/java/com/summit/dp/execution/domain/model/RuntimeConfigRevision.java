package com.summit.dp.execution.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/** 配置版本只追加，防止设置修改后改变已受理执行的恢复参数。 */
@Getter
@Builder
public class RuntimeConfigRevision {
    private final Long id;
    private final String kind;
    private final Long configId;
    private final int revision;
    private final String fingerprint;
    private final String payload;
    private final Instant createdAt;
}
