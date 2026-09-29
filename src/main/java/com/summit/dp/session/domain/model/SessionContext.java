package com.summit.dp.session.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;
@Builder
@Getter
public class SessionContext {
    private final Long sessionId;
    private String content;
    private Long version;
    private final Instant createTime;
    private Instant updateTime;

    /**
     * 首写工厂：新会话的上下文快照从零版本起建。
     * <p>version 置 0，经 {@link #changeContent(String)} 首写后自增为 1，
     * 与 DDL {@code version BIGINT NOT NULL DEFAULT 1} 的新行语义对齐。</p>
     */
    public static SessionContext create(Long sessionId) {
        Instant now = Instant.now();
        return SessionContext.builder()
                .sessionId(sessionId)
                .version(0L)
                .createTime(now)
                .updateTime(now)
                .build();
    }

    public void changeContent(String content){
        this.content = content;
        this.version = this.version + 1;
        this.updateTime = Instant.now();
    }






}
