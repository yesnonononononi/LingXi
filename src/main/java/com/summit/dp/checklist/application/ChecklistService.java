package com.summit.dp.checklist.application;

import java.util.Optional;

/**
 * 清单应用服务：四个工具与收尾提醒的唯一写入入口。
 *
 * <p>约定：业务失败一律抛 {@code ClientException}（中文文案直接回给模型），
 * 不返回半成品快照；成功则返回权威快照。事务边界在这里，聚合之外没有第二个写入口。</p>
 */
public interface ChecklistService {

    /** 新建清单；同会话已有活动清单时拒绝。 */
    ChecklistVO create(ChecklistCommand command);

    /** 开始不刷新提醒额度，写入结果才算实际推进。 */
    ChecklistVO updateStep(ChecklistCommand command);

    /** 修改标题、改步骤内容、增删与重排步骤。 */
    ChecklistVO modify(ChecklistCommand command);

    /** 软删清单；重复删除返回既有删除事实。 */
    ChecklistVO delete(ChecklistCommand command);

    /** 读取会话当前的活动清单，用于给模型补上下文。 */
    Optional<ChecklistVO> findActive(long sessionId);

    /** 界面读取最近清单，终态仍可回看。 */
    Optional<ChecklistVO> findCurrent(Long sessionId);

    /** 自然收尾只信任本执行、当前进展版本的投递事实。 */
    ReminderDecision remindOnNaturalComplete(ChecklistReminderContext context);
}
