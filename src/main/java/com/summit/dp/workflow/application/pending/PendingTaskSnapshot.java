package com.summit.dp.workflow.application.pending;

import java.util.List;

/**
 * 待发送队列快照（前端面板的数据源）。
 *
 * <p>只给计数不给图片内容：面板每秒轮询一次，把 base64 塞进来等于每秒几 MB 的 JSON。
 * 缩略图走单独接口懒加载。</p>
 */
public record PendingTaskSnapshot(boolean paused, String failure, List<Entry> entries) {

    /**
     * 一条待发送任务的展示视图。
     *
     * @param dispatching 本进程正在派发（内存标记，不落库）
     * @param imageCount  附件数量，前端据此显示「N 张图片」
     * @param status      PENDING / PAUSED / AWAITING_CONFIRM
     */
    public record Entry(String id, String input, boolean dispatching, int imageCount, String status) {
    }
}
