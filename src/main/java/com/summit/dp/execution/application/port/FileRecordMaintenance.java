package com.summit.dp.execution.application.port;

import java.time.Instant;
import java.util.Collection;

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
     * {@code cutoff} 之前建立、下次清理会回收的记录条数。
     *
     * <p>预览必须报这个数：清理动作本来就会删它们，预览若只说「没有可回收执行」，
     * 界面就会出现「预览说没啥可清、点一下却删了东西」—— 那是不诚实的预览。</p>
     */
    long countBefore(Instant cutoff);

    /**
     * 回收 {@code cutoff} 之前建立的记录。
     *
     * @return 实际删除的记录条数（0 表示没有可回收内容，重复调用幂等）
     */
    int purgeBefore(Instant cutoff);

    /**
     * 按执行批量回收：行在调用方事务内删掉，基线目录在事务提交后才删。
     *
     * <p><b>为什么会话删除必须走到这里</b>：{@code file_record} 只按 {@code execution_id} 归属，
     * 没有会话列。会话行一删，这些记录既不可展示也不可重放，但基线文件仍占着磁盘；
     * 只靠按时间淘汰的话，它们要等到 {@code cutoff} 之后才走，长会话删完还剩一坨垃圾。
     * 按批一次删行，是为了避免「逐执行调一次单条删除」把删除动作变成 N 次往返。</p>
     *
     * <p><b>顺序不能反</b>：先删行、提交后再删目录。反过来一旦事务回滚，
     * 就留下「有行、没基线」的记录，重放会把它当成「整份文件新增」。</p>
     *
     * @param executionIds 执行标识（数字串）；空入参直接返回 {@code 0}
     * @return 删除的记录条数
     */
    int deleteByExecutionIds(Collection<String> executionIds);
}
