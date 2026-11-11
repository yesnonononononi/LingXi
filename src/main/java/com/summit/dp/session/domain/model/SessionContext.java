package com.summit.dp.session.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/**
 * 会话的模型推理上下文。
 *
 * <p><b>正文不在这个对象里</b>：整段上下文由 {@code SessionContextStore} 写成 JSONL 文件，
 * 这里只持有正文标识。正文若留在 CLOB 列，每轮整笔替换都要让 H2 追加一份 LOB 且永不回退，
 * 库体积会随对话轮次线性膨胀。</p>
 *
 * <p>上下文压缩只重写这份正文，不重建本表的行，也不碰对话记录。</p>
 */
@Builder
@Getter
public class SessionContext {
    private final Long sessionId;
    /** 正文标识（正文文件名去掉扩展名）；{@code null} 表示还没有落过盘（新会话，或历史行尚未迁移）。 */
    private String snapshotFile;
    private Long version;
    private final Instant createTime;
    private Instant updateTime;

    /**
     * 首写工厂：新会话的上下文快照从零版本起建。
     * <p>version 置 0，经 {@link #changeSnapshot(String)} 首写后自增为 1，
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

    /**
     * 记下一次正文替换：正文标识与版本号一起前进。
     *
     * <p>正文由调用方先落盘再调这里 —— 本方法只负责记下「哪一份文件是当前版本」。</p>
     */
    public void changeSnapshot(String snapshotFile) {
        if (snapshotFile == null || snapshotFile.isBlank()) {
            throw new IllegalArgumentException("会话上下文正文标识不能为空");
        }
        this.snapshotFile = snapshotFile;
        this.version = this.version + 1;
        this.updateTime = Instant.now();
    }

    /**
     * 轻量摘要：只带会话标识、版本号与正文标识，不带正文。
     *
     * <p><b>为什么需要它</b>：替换是覆盖写，不需要旧正文；读正文只需要正文标识，
     * 也不需要把历史内容搬进堆。摘要查询只读 {@code session_id / version / snapshot_file}，
     * 因此它同时服务「判行存不存在」与「取当前正文标识」两条路径。</p>
     *
     * @param sessionId    会话标识
     * @param version      库里的当前版本号；null 视为 0（与 {@link #create(Long)} 从零起建一致）
     * @param snapshotFile 库里的正文标识，可空
     */
    public static SessionContext restoreSummary(Long sessionId, Long version, String snapshotFile) {
        return SessionContext.builder()
                .sessionId(sessionId)
                .version(version == null ? 0L : version)
                .snapshotFile(snapshotFile)
                .build();
    }






}
