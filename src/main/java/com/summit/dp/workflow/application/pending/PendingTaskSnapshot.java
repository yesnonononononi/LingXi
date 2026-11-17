package com.summit.dp.workflow.application.pending;

import java.util.List;

/**
 * 待发送队列快照（前端面板的数据源）。
 *
 * <p>只给附件标识与名字，不给图片内容：面板每秒轮询一次，把 base64 塞进来等于每秒几 MB 的 JSON。
 * 缩略图走 {@code PendingTaskService#readAttachment} 对应的单独接口按需加载。</p>
 */
public record PendingTaskSnapshot(boolean paused, String failure, List<Entry> entries) {

    /**
     * 一条待发送任务的展示视图。
     *
     * @param dispatching 本进程正在派发（内存标记，不落库）
     * @param attachments 附件清单：id 用来拼缩略图 URL，name 只作提示与换名回填
     * @param status      PENDING / PAUSED / AWAITING_CONFIRM
     */
    public record Entry(String id, String input, boolean dispatching,
                        List<Attachment> attachments, String status) {
    }

    /** 附件的展示身份；字节永远不随快照下发。 */
    public record Attachment(String id, String name) {
    }
}
