package com.summit.dp.checklist.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.checklist.domain.model.Checklist;
import com.summit.dp.checklist.domain.model.ChecklistStep;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * 清单聚合仓储。
 *
 * <p>聚合一致性靠父行锁保证：任何写入口都先锁 checklist 行，再读步骤、跑领域方法、落库。
 * 因此这里提供的是「带锁读 + 精确写」的窄接口，而不是让调用方自己组合 Mapper。</p>
 */
public interface ChecklistRepository extends RepositoryTemplate<Checklist, Long> {

    /** 新建聚合（清单行 + 全部步骤行）；ACTIVE 唯一性由数据库派生列唯一索引裁决。 */
    void saveAggregate(Checklist checklist);

    /** 只更新清单行（状态、进度版本、提醒字段、标题）；步骤行由下面三个方法精确处理。 */
    void updateChecklist(Checklist checklist);

    /** 只读聚合（含步骤），不加锁。 */
    Optional<Checklist> findByIdWithSteps(long checklistId);

    /** 会话当前的活动清单（含步骤），不加锁；用于给模型补上下文与友好报错。 */
    Optional<Checklist> findActiveBySessionId(long sessionId);

    /** 最新清单保留终态；删除后不让历史清单重新冒出。 */
    Optional<Checklist> findCurrentBySessionId(long sessionId);

    /**
     * 会话最近一份清单，**不按状态过滤**（含已软删）。
     *
     * <p>与 {@link #findCurrentBySessionId(long)} 的分工是本次设计要点：那条是「还能不能继续干活」，
     * 这条是「用户要看历史」。混用一个查询会让卡片在删除后凭空消失，或者让已删清单重新变成活动清单。</p>
     */
    Optional<Checklist> findLatestBySessionId(long sessionId);

    /** 会话当前的活动清单（含步骤），行级加锁；写入路径必须走它。 */
    Optional<Checklist> findActiveBySessionIdForUpdate(long sessionId);

    /** 按标识锁住清单行（含步骤）；删除与修改需要按标识定位，就靠它。 */
    Optional<Checklist> findByIdForUpdate(long checklistId);

    /** 只占用同会话、同进展版本的 ACTIVE 额度，未命中不代表无进展。 */
    boolean claimReminder(Checklist checklist, long executionId);

    void insertStep(ChecklistStep step);

    void updateStep(ChecklistStep step);

    void deleteStep(long stepId);

    /** 批量删除步骤；用于测试与清理，业务路径逐条删除以便精确回滚。 */
    void deleteSteps(Collection<Long> stepIds);

    /** 会话的全部清单（按标识倒序）；供测试与排障观察历史。 */
    List<Checklist> findAllBySessionId(long sessionId);
}
