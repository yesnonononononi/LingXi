package com.summit.dp.checklist.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.checklist.domain.model.Checklist;
import com.summit.dp.checklist.domain.model.ChecklistStatus;
import com.summit.dp.checklist.domain.model.ChecklistStep;
import com.summit.dp.checklist.domain.model.ChecklistStepStatus;
import com.summit.dp.checklist.domain.repository.ChecklistRepository;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistMapper;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistStepMapper;
import com.summit.dp.checklist.infrastructure.persistence.po.ChecklistPO;
import com.summit.dp.checklist.infrastructure.persistence.po.ChecklistStepPO;
import com.summit.dp.shared.exception.ClientException;
import jakarta.validation.constraints.NotNull;
import org.springframework.beans.BeanUtils;
import org.springframework.stereotype.Repository;

import java.time.Instant;
import java.util.*;

/**
 * 清单聚合仓储实现。
 *
 * <p>聚合装配方式：清单行 + 按 seq 排序的步骤行。步骤永远随父行一起读，
 * 因为「还剩什么没做」和「清单是什么状态」必须来自同一份快照。</p>
 */
@Repository
public class ChecklistRepositoryImpl extends AbstractRepository<Checklist, ChecklistPO, Long>
        implements ChecklistRepository {

    private final ChecklistMapper mapper;
    private final ChecklistStepMapper stepMapper;

    public ChecklistRepositoryImpl(ChecklistMapper mapper, ChecklistStepMapper stepMapper) {
        this.mapper = mapper;
        this.stepMapper = stepMapper;
    }

    @Override
    protected @NotNull BaseMapper<ChecklistPO> mapper() {
        return mapper;
    }

    @Override
    public void save(Checklist entity) {
        saveAggregate(entity);
    }

    @Override
    public void saveAggregate(Checklist checklist) {
        if (checklist == null) {
            return;
        }
        ChecklistPO row = toPO(checklist);
        mapper.insert(row);
        checklist.acceptPersistedState();
        for (ChecklistStep step : checklist.getSteps()) {
            stepMapper.insert(toStepPO(step));
        }
    }

    /** 父行锁保护聚合裁决，条件更新额外拒绝过期对象覆盖。 */
    @Override
    public void updateChecklist(Checklist checklist) {
        if (checklist == null) {
            return;
        }
        ChecklistPO row = toPO(checklist);
        int changed = mapper.update(row, new LambdaUpdateWrapper<ChecklistPO>()
                .eq(ChecklistPO::getId, checklist.getId())
                .eq(ChecklistPO::getProgressVersion, checklist.getPersistedProgressVersion())
                .eq(ChecklistPO::getStatus, checklist.getPersistedStatus()));
        if (changed != 1) {
            throw new ClientException("清单进展已变化，请重新读取后再修改: checklistId=" + checklist.getId());
        }
        checklist.acceptPersistedState();
    }

    @Override
    public void updateById(Checklist entity) {
        updateChecklist(entity);
    }

    @Override
    public Optional<Checklist> findById(Long id) {
        return id == null ? Optional.empty() : findByIdWithSteps(id);
    }

    @Override
    public Optional<Checklist> findByIdWithSteps(long checklistId) {
        ChecklistPO row = mapper.selectById(checklistId);
        return Optional.ofNullable(row).map(this::toModel);
    }

    @Override
    public Optional<Checklist> findActiveBySessionId(long sessionId) {
        ChecklistPO row = mapper.selectOne(new LambdaQueryWrapper<ChecklistPO>()
                .eq(ChecklistPO::getSessionId, sessionId)
                .eq(ChecklistPO::getStatus, ChecklistStatus.ACTIVE.name()));
        return Optional.ofNullable(row).map(this::toModel);
    }

    @Override
    public Optional<Checklist> findCurrentBySessionId(long sessionId) {
        Optional<Checklist> active = findActiveBySessionId(sessionId);
        if (active.isPresent()) {
            return active;
        }
        ChecklistPO row = mapper.selectOne(new LambdaQueryWrapper<ChecklistPO>()
                .eq(ChecklistPO::getSessionId, sessionId)
                .orderByDesc(ChecklistPO::getId)
                .last("LIMIT 1"));
        return Optional.ofNullable(row).filter(current -> !ChecklistStatus.DELETED.name().equals(current.getStatus()))
                .map(this::toModel);
    }

    @Override
    public Optional<Checklist> findLatestBySessionId(long sessionId) {
        ChecklistPO row = mapper.selectOne(new LambdaQueryWrapper<ChecklistPO>()
                .eq(ChecklistPO::getSessionId, sessionId)
                .orderByDesc(ChecklistPO::getId)
                .last("LIMIT 1"));
        return Optional.ofNullable(row).map(this::toModel);
    }

    /** 父行锁保护聚合裁决，条件更新额外拒绝过期对象覆盖。 */
    @Override
    public Optional<Checklist> findActiveBySessionIdForUpdate(long sessionId) {
        ChecklistPO row = mapper.selectActiveBySessionIdForUpdate(sessionId);
        return Optional.ofNullable(row).map(this::toModel);
    }

    /** 同上：按标识定位聚合，并取得本事务的清单写权。 */
    @Override
    public Optional<Checklist> findByIdForUpdate(long checklistId) {
        ChecklistPO row = mapper.selectByIdForUpdate(checklistId);
        return Optional.ofNullable(row).map(this::toModel);
    }

    @Override
    public boolean claimReminder(Checklist checklist, long executionId) {
        return mapper.claimReminder(checklist.getId(), checklist.getSessionId(), checklist.getProgressVersion(),
                executionId, Instant.now()) == 1;
    }

    @Override
    public void insertStep(ChecklistStep step) {
        stepMapper.insert(toStepPO(step));
    }

    /**
     * 更新单个步骤：带 {@code status} 条件，避免「读后裸写」覆盖并发推进结果。
     *
     * <p>步骤推进必须先取得父行锁；这里是第二道防线，条件不成立即拒绝。</p>
     */
    @Override
    public void updateStep(ChecklistStep step) {
        ChecklistStepPO current = stepMapper.selectById(step.getId());
        if (current == null) {
            throw new ClientException("清单步骤不存在或已被删除: stepId=" + step.getId());
        }
        ChecklistStepPO row = toStepPO(step);
        int changed = stepMapper.update(row, new LambdaUpdateWrapper<ChecklistStepPO>()
                .eq(ChecklistStepPO::getId, step.getId())
                .eq(ChecklistStepPO::getStatus, current.getStatus()));
        if (changed != 1) {
            throw new ClientException("清单步骤状态已变化，请重新读取后再修改: stepId=" + step.getId());
        }
    }

    @Override
    public void deleteStep(long stepId) {
        stepMapper.deleteById(stepId);
    }

    @Override
    public void deleteSteps(Collection<Long> stepIds) {
        if (stepIds == null || stepIds.isEmpty()) {
            return;
        }
        stepMapper.deleteByIds(stepIds);
    }

    @Override
    public List<Checklist> findAllBySessionId(long sessionId) {
        return mapper.selectList(new LambdaQueryWrapper<ChecklistPO>()
                        .eq(ChecklistPO::getSessionId, sessionId)
                        .orderByDesc(ChecklistPO::getId))
                .stream().filter(Objects::nonNull).map(this::toModel).toList();
    }

    @Override
    protected Checklist toModel(ChecklistPO po) {
        return Checklist.restore(
                po.getId(), po.getSessionId(), po.getAgentId(), po.getTitle(),
                ChecklistStatus.valueOf(po.getStatus()), po.isRemindStatus(), po.getProgressVersion(),
                po.getRemindExecutionId(), po.getRemindedProgressVersion(),
                po.getCreateAt(), po.getUpdateAt(), loadSteps(po.getId()));
    }

    @Override
    protected ChecklistPO toPO(Checklist model) {
        ChecklistPO po = new ChecklistPO();
        BeanUtils.copyProperties(model, po);
        po.setStatus(model.getStatus().name());
        po.setProgressVersion(model.getProgressVersion());
        po.setRemindStatus(model.isRemindStatus());
        return po;
    }

    private List<ChecklistStep> loadSteps(Long checklistId) {
        return stepMapper.selectList(new LambdaQueryWrapper<ChecklistStepPO>()
                        .eq(ChecklistStepPO::getChecklistId, checklistId)
                        .orderByAsc(ChecklistStepPO::getSeq))
                .stream().filter(Objects::nonNull).map(this::toStepModel).toList();
    }

    private ChecklistStep toStepModel(ChecklistStepPO po) {
        return ChecklistStep.restore(po.getId(), po.getChecklistId(), po.getSeq(), po.getContent(),
                ChecklistStepStatus.valueOf(po.getStatus()), po.getUpdateAt());
    }

    private ChecklistStepPO toStepPO(ChecklistStep step) {
        ChecklistStepPO po = new ChecklistStepPO();
        po.setId(step.getId());
        po.setChecklistId(step.getChecklistId());
        po.setSeq(step.getSeq());
        po.setContent(step.getContent());
        po.setStatus(step.getStatus().name());
        po.setUpdateAt(step.getUpdateAt());
        return po;
    }
}
