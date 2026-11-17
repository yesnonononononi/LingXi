package com.summit.dp.workflow.application.pending;

import com.summit.dp.workflow.domain.pending.model.PendingAttachment;

import java.util.Collection;
import java.util.List;

/**
 * 待发送附件的落盘存储。
 *
 * <p>字节预算在这里兜底（磁盘事实），MIME 与数量校验留在应用层（业务语义）：
 * 分开的理由是「磁盘能放多少」与「一条消息配几张图」是两条独立的规则。</p>
 */
public interface PendingAttachmentStore {

    /** 单条任务附件总字节上限，与 multipart 的 max-request-size 一致。 */
    long MAX_TASK_BYTES = 12L * 1024 * 1024;

    /** 单会话排队附件总字节上限：图片进队列后没有这条，10MB × 100 条能把桌面端打爆。 */
    long MAX_SESSION_BYTES = 120L * 1024 * 1024;

    /**
     * 写入一组上传，返回已落盘的附件引用。
     *
     * <p>实现必须先写临时文件再改名：半截文件被派发读到，比失败更糟。
     * 任一环节失败要清掉本次已写文件再抛，不留残骸。</p>
     */
    List<PendingAttachment> store(long sessionId, long taskId, List<PendingUpload> uploads);

    /** 读取附件字节，供派发时构造模型图片。 */
    byte[] read(PendingAttachment attachment);

    /** 删除整条任务的附件目录（派发成功、用户取消、会话删除）。 */
    void deleteTask(long sessionId, long taskId);

    /** 删除整个会话的附件目录（会话被删除时用）。 */
    void deleteSession(long sessionId);

    /** 删除指定附件（修改时的交并：被过滤掉的那些）。 */
    void deleteAttachments(long sessionId, long taskId, Collection<String> attachmentIds);

    /** 该会话已占用的附件字节数。 */
    long usedBytes(long sessionId);
}
