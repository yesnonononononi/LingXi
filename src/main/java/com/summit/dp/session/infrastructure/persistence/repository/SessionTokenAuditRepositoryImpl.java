package com.summit.dp.session.infrastructure.persistence.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.SessionTokenAuditItem;
import com.summit.dp.session.domain.model.TokenAuditCategory;
import com.summit.dp.session.domain.model.TokenAuditGroupKind;
import com.summit.dp.session.domain.model.TokenAuditItemLevel;
import com.summit.dp.session.domain.model.TokenAuditPersistedState;
import com.summit.dp.session.domain.repo.SessionTokenAuditRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionTokenAuditItemMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionTokenAuditMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionTokenAuditItemPO;
import com.summit.dp.session.infrastructure.persistence.po.SessionTokenAuditPO;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * 审计快照仓储实现：头表 upsert + 明细「先删后插」，全部在同一个事务里。
 *
 * <p>为什么不用 {@code saveOrUpdate} 的默认语义：MyBatis-Plus 的 {@code updateById} 只写非空字段，
 * 上一轮成功快照里的 {@code fail_reason}、数值列不会被清空。这里用
 * {@link LambdaUpdateWrapper} 显式 set 每一列（允许写 null），做到「整行替换」而不是「打补丁」。</p>
 */
@Repository
@RequiredArgsConstructor
public class SessionTokenAuditRepositoryImpl
        extends AbstractRepository<SessionTokenAudit, SessionTokenAuditPO, Long>
        implements SessionTokenAuditRepository {

    private final SessionTokenAuditMapper auditMapper;
    private final SessionTokenAuditItemMapper itemMapper;

    @Override
    protected BaseMapper<SessionTokenAuditPO> mapper() {
        return auditMapper;
    }

    /** 模板要求的头表映射；明细由 {@link #findBySessionId(Long)} 装配，此处一律不查明细。 */
    @Override
    protected SessionTokenAuditPO toPO(SessionTokenAudit entity) {
        if (entity == null) {
            return null;
        }
        return SessionTokenAuditPO.builder()
                .sessionId(entity.getSessionId())
                .executionId(entity.getExecutionId())
                .auditState(entity.getState().name())
                .totalTokens(entity.getTotalTokens())
                .maxTokens(entity.getMaxTokens())
                .messagesTokens(entity.getMessagesTokens())
                .requestOverheadTokens(entity.getRequestOverheadTokens())
                .overlapTokens(entity.getOverlapTokens())
                .capturedAt(entity.getCapturedAt())
                .failReason(entity.getFailReason())
                .build();
    }

    /**
     * 头表单独还原：只用于框架模板的兜底路径（分页等）。
     *
     * <p>业务读写一律走 {@link #findBySessionId(Long)}，因为它会一并装配明细行；
     * 拿这个方法的返回值当完整聚合用会漏掉明细。</p>
     */
    @Override
    protected SessionTokenAudit toModel(SessionTokenAuditPO po) {
        return restore(po, List.of());
    }

    /** 模板的按主键查询也装配明细：主键就是会话 id，两者语义完全一致。 */
    @Override
    public Optional<SessionTokenAudit> findById(Long id) {
        return findBySessionId(id);
    }

    @Override
    public Optional<SessionTokenAudit> findBySessionId(Long sessionId) {
        if (sessionId == null) {
            return Optional.empty();
        }
        SessionTokenAuditPO head = auditMapper.selectById(sessionId);
        if (head == null) {
            return Optional.empty();
        }
        return Optional.of(restore(head, loadItems(sessionId)));
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
    public void replaceSnapshot(SessionTokenAudit audit) {
        requireCollected(audit);
        replaceHead(audit);
        itemMapper.delete(new LambdaQueryWrapper<SessionTokenAuditItemPO>()
                .eq(SessionTokenAuditItemPO::getSessionId, audit.getSessionId()));
        for (SessionTokenAuditItem item : audit.getItems()) {
            itemMapper.insert(toItemPO(audit.getSessionId(), item));
        }
    }

    @Override
    @Transactional(rollbackFor = Exception.class)
    public void markFailed(Long sessionId, Long executionId, String reason) {
        if (sessionId == null) {
            throw new ClientException("token 审计快照必须归属一个会话");
        }
        TokenAuditPersistedState current = currentState(sessionId);
        if (current == TokenAuditPersistedState.COLLECTED) {
            // 已有成功快照：失败不覆盖，保住唯一可解释的事实。
            return;
        }
        SessionTokenAudit failure = SessionTokenAudit.failure(sessionId, executionId, reason, Instant.now());
        replaceHead(failure);
        itemMapper.delete(new LambdaQueryWrapper<SessionTokenAuditItemPO>()
                .eq(SessionTokenAuditItemPO::getSessionId, sessionId));
    }

    /**
     * 读当前持久状态。
     *
     * @return 行不存在时返回 {@code null}（没有状态这一事实本身要能表达）
     */
    private TokenAuditPersistedState currentState(Long sessionId) {
        SessionTokenAuditPO head = auditMapper.selectById(sessionId);
        if (head == null) {
            return null;
        }
        return TokenAuditPersistedState.fromName(head.getAuditState());
    }

    /** 头表 upsert：整行替换，允许把上一轮的 fail_reason / 数值列写回 null。 */
    private void replaceHead(SessionTokenAudit audit) {
        Long sessionId = audit.getSessionId();
        boolean exists = auditMapper.selectById(sessionId) != null;
        if (!exists) {
            auditMapper.insert(toPO(audit));
            return;
        }
        auditMapper.update(null, new LambdaUpdateWrapper<SessionTokenAuditPO>()
                .eq(SessionTokenAuditPO::getSessionId, sessionId)
                .set(SessionTokenAuditPO::getExecutionId, audit.getExecutionId())
                .set(SessionTokenAuditPO::getAuditState, audit.getState().name())
                .set(SessionTokenAuditPO::getTotalTokens, audit.getTotalTokens())
                .set(SessionTokenAuditPO::getMaxTokens, audit.getMaxTokens())
                .set(SessionTokenAuditPO::getMessagesTokens, audit.getMessagesTokens())
                .set(SessionTokenAuditPO::getRequestOverheadTokens, audit.getRequestOverheadTokens())
                .set(SessionTokenAuditPO::getOverlapTokens, audit.getOverlapTokens())
                .set(SessionTokenAuditPO::getCapturedAt, audit.getCapturedAt())
                .set(SessionTokenAuditPO::getFailReason, audit.getFailReason())
                .set(SessionTokenAuditPO::getUpdateTime, Instant.now()));
    }

    private void requireCollected(SessionTokenAudit audit) {
        if (audit == null) {
            throw new ClientException("token 审计快照不能为空");
        }
        if (audit.getSessionId() == null) {
            throw new ClientException("token 审计快照必须归属一个会话");
        }
        if (audit.getState() != TokenAuditPersistedState.COLLECTED) {
            throw new ClientException("只有成功采集的快照才能整体替换: state=" + audit.getState());
        }
    }

    /** 明细按 (item_level, sort_order) 读回：与索引顺序一致，装配后无需再排。 */
    private List<SessionTokenAuditItem> loadItems(Long sessionId) {
        List<SessionTokenAuditItemPO> rows = itemMapper.selectList(
                new LambdaQueryWrapper<SessionTokenAuditItemPO>()
                        .eq(SessionTokenAuditItemPO::getSessionId, sessionId)
                        .orderByAsc(SessionTokenAuditItemPO::getItemLevel)
                        .orderByAsc(SessionTokenAuditItemPO::getSortOrder));
        List<SessionTokenAuditItem> items = new ArrayList<>(rows.size());
        for (SessionTokenAuditItemPO row : rows) {
            items.add(toItem(row));
        }
        return items;
    }

    private SessionTokenAudit restore(SessionTokenAuditPO head, List<SessionTokenAuditItem> items) {
        return SessionTokenAudit.restore(
                head.getSessionId(),
                head.getExecutionId(),
                TokenAuditPersistedState.fromName(head.getAuditState()),
                head.getTotalTokens(),
                head.getMaxTokens(),
                head.getMessagesTokens(),
                head.getRequestOverheadTokens(),
                head.getOverlapTokens(),
                head.getCapturedAt(),
                head.getFailReason(),
                items);
    }

    private SessionTokenAuditItemPO toItemPO(Long sessionId, SessionTokenAuditItem item) {
        if (item == null) {
            throw new ClientException("token 审计明细行不能为空");
        }
        return SessionTokenAuditItemPO.builder()
                .sessionId(sessionId)
                .itemLevel(item.getLevel().code())
                .category(item.getCategory().name())
                .groupKind(item.getGroupKind() == null ? null : item.getGroupKind().name())
                .toolName(item.getToolName())
                .callCount(item.getCallCount())
                .totalTokens(item.getTotalTokens())
                .argumentTokens(item.getArgumentTokens())
                .outputTokens(item.getOutputTokens())
                .sortOrder(item.getSortOrder())
                .build();
    }

    private SessionTokenAuditItem toItem(SessionTokenAuditItemPO row) {
        return SessionTokenAuditItem.restore(
                row.getId(),
                TokenAuditItemLevel.fromCode(row.getItemLevel()),
                TokenAuditCategory.fromName(row.getCategory()),
                TokenAuditGroupKind.fromName(row.getGroupKind()),
                row.getToolName(),
                defaultInt(row.getCallCount()),
                defaultInt(row.getTotalTokens()),
                defaultInt(row.getArgumentTokens()),
                defaultInt(row.getOutputTokens()),
                defaultInt(row.getSortOrder()));
    }

    /** 列都有 DEFAULT 0，但手工插入的老行可能为 NULL；null 当 0 处理，不让读路径空指针。 */
    private static int defaultInt(Integer value) {
        return Objects.requireNonNullElse(value, 0);
    }
}
