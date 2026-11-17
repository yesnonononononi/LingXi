package com.summit.dp.workflow.application.pending;

/**
 * 一次待发送附件的上传内容：已经从 {@code MultipartFile} 读成字节。
 *
 * <p>为什么不在存储接口里直接吃 {@code MultipartFile}：请求结束后它的临时文件就被清了，
 * 而落盘动作可能晚于请求线程（修改 pending）。字节是这里唯一稳定的形态。</p>
 */
public record PendingUpload(String name, String mime, byte[] data) {
}
