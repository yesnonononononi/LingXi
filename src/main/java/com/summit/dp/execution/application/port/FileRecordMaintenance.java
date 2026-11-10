package com.summit.dp.execution.application.port;

import java.time.Instant;

/**
 * 文件编辑记录的回收口：清理入口据此按时间淘汰旧记录（含落盘的基线大文本）。
 *
 * <p><b>为什么在执行模块声明端口</b>：清理动作属于「无用数据回收」，入口在执行模块；
 * 记录本体在文件工具侧，实现由它提供。端口放在这里，依赖方向就是
 * 工作流 → 执行（既有方向），不必让执行反向依赖文件工具。</p>
 *
 * <p><b>为什么整条回收而不是只删基线</b>：只删基线会留下「基线缺失」的活记录，
 * 它被读回来时与「本轮新建文件」同形，历史差异会被算成整份文件新增 —— 静默给出错误数字，
 * 比缺一条记录糟得多。过期记录本身也没有展示位。</p>
 */
public interface FileRecordMaintenance {

    /**
     * 回收 {@code cutoff} 之前建立的记录。
     *
     * @return 实际删除的记录条数（0 表示没有可回收内容，重复调用幂等）
     */
    int purgeBefore(Instant cutoff);
}
