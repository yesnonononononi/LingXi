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

    /**
     * 按权威标识精确读取任意状态的清单，含已软删的历史，用于审计与复核。
     *
     * <p>与 {@link #findCurrent(Long)} 的差别：那条路径刻意跳过 DELETED，只服务于「继续干活」；
     * 本方法不参与任何写判定，仅把「删掉之后到底发生了什么」重新变成可读事实。
     * 归属仍以会话为准，跨会话读取一律拒绝。</p>
     */
    Optional<ChecklistVO> findById(long sessionId, Long checklistId);

    /**
     * 会话最近一份清单，**包含已软删**，只用于界面常驻展示与用户审计。
     *
     * <p>刻意与 {@link #findCurrent(Long)} 分开：那条决定「模型还能不能接着干」，会跳过 DELETED；
     * 这条决定「用户能不能看见发生过什么」，所以删除后卡片不该凭空消失。
     * 本方法不参与任何写判定，返回的 DELETED 快照也不代表清单可以复活。</p>
     */
    Optional<ChecklistVO> findLatestForDisplay(long sessionId);

    /** 自然收尾只信任本执行、当前进展版本的投递事实。 */
    ReminderDecision remindOnNaturalComplete(ChecklistReminderContext context);
}
