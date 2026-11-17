package com.summit.dp.workflow.domain.pending.model;

import com.summit.dp.shared.exception.ClientException;

/**
 * 待发送任务的一个附件引用：文件在磁盘上，这里只保留定位信息。
 *
 * <p>{@code relPath} 由服务端拼装，客户端永远只回传 {@code id} —— 让客户端传路径，
 * 路径穿越就只差一层校验。</p>
 */
public record PendingAttachment(String id, String name, String mime, long size, String relPath) {

    public PendingAttachment {
        if (id == null || id.isBlank() || mime == null || !mime.startsWith("image/")
                || relPath == null || relPath.isBlank() || size <= 0) {
            throw new ClientException("待发送附件信息不完整");
        }
        // 相对路径只允许「目录/文件名」两层，出现上跳或绝对路径一律拒绝。
        String normalized = relPath.replace('\\', '/');
        if (normalized.startsWith("/") || normalized.contains("../") || normalized.contains("..\\")) {
            throw new ClientException("待发送附件路径不合法");
        }
    }
}
