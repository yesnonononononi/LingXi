package com.summit.dp.workflow.application.pending;

/**
 * 一条排队附件的原始内容。
 *
 * <p>只给缩略图与「回填编辑」用：字节按需读取，读完即丢，不缓存、不驻留内存。</p>
 *
 * @param name 用户上传时的文件名，仅作提示
 * @param mime 已在上传阶段校验为 image/png|jpeg|webp|gif
 * @param data 原始字节
 */
public record PendingAttachmentContent(String name, String mime, byte[] data) {
}
