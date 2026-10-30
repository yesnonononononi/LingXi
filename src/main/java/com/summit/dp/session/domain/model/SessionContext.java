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

    /**
     * 轻量摘要：只带会话标识与版本号，不带正文。
     *
     * <p><b>为什么需要它</b>：压缩/收尾要「整体替换正文」，那是一次覆盖写，
     * 根本不需要知道旧正文是什么。旧实现为了判「行存不存在」把整段上下文 JSON 读进堆，
     * 长会话下就是几十 MB 的无用峰值。摘要查询只读 {@code session_id} 与 {@code version}，
     * 拿到后再由 {@link #changeContent(String)} 写新正文 —— 语义与旧实现一致（版本照样 +1）。</p>
     *
     * @param sessionId 会话标识
     * @param version   库里的当前版本号；null 视为 0（与 {@link #create(Long)} 从零起建一致）
     */
    public static SessionContext restoreSummary(Long sessionId, Long version) {
        return SessionContext.builder()
                .sessionId(sessionId)
                .version(version == null ? 0L : version)
                .build();
    }






}
