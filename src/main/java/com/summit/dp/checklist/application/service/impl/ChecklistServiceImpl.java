package com.summit.dp.checklist.application.service.impl;

import cn.hutool.core.util.IdUtil;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistReminderContext;
import com.summit.dp.checklist.application.ChecklistReminderOwnership;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.application.ReminderDecision;
import com.summit.dp.checklist.domain.model.Checklist;
import com.summit.dp.checklist.domain.model.ChecklistModification;
import com.summit.dp.checklist.domain.model.ChecklistMutation;
import com.summit.dp.checklist.domain.model.ChecklistRules;
import com.summit.dp.checklist.domain.model.ChecklistStatus;
import com.summit.dp.checklist.domain.model.ChecklistStep;
import com.summit.dp.checklist.domain.model.ChecklistStepStatus;
import com.summit.dp.checklist.domain.repository.ChecklistRepository;
import com.summit.dp.shared.exception.ClientException;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** 所有写入先锁父行，步骤推进与提醒收口必须在同一聚合事务中裁决。 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ChecklistServiceImpl implements ChecklistService {

    private final ChecklistRepository repository;
    private final ChecklistReminderOwnership reminderOwnership;

    @Override
    @Transactional
    public ChecklistVO create(ChecklistCommand command) {
        throwIf(command == null, "清单参数不能为空");
        long sessionId = requireSessionId(command.getSessionId());
        List<String> contents = ChecklistRules.normalizeStepContents(command.getSteps());

        // 先查一次只是为了给出可读文案；并发下的唯一性由派生列唯一索引裁决，不靠这次查询。
        repository.findActiveBySessionId(sessionId).ifPresent(existing -> {
            throw new ClientException("当前会话已有活动清单（ID " + existing.getId()
                    + "），请先更新或删除它，再新建清单");
        });

        long checklistId = IdUtil.getSnowflakeNextId();
        List<ChecklistStep> steps = new ArrayList<>();
        for (String content : contents) {
            steps.add(ChecklistStep.pending(IdUtil.getSnowflakeNextId(), checklistId,
                    steps.size() + 1, content, Instant.now()));
        }
        Checklist checklist = Checklist.create(checklistId, sessionId, command.getAgentId(),
                command.getTitle(), steps, Instant.now());
        try {
            repository.saveAggregate(checklist);
        } catch (DataIntegrityViolationException duplicated) {
            // 唯一索引拒绝：可能是并发创建，也可能是老的 ACTIVE 清单还在
            throw new ClientException("当前会话已有活动清单，同一会话只能有一份活动清单", duplicated);
        }
        log.info("创建执行清单: checklistId={}, sessionId={}, steps={}", checklistId, sessionId, steps.size());
        return toVO(checklist);
    }

    @Override
    @Transactional
    public ChecklistVO updateStep(ChecklistCommand command) {
        throwIf(command == null, "清单参数不能为空");
        long sessionId = requireSessionId(command.getSessionId());
        throwIf(command.getStepId() == null, "更新步骤需要提供 stepId");
        ChecklistStepStatus next = ChecklistRules.parseStepStatus(command.getStatus());
        throwIf(command.isContinueNextStep() && !next.isTerminal(),
                "只有上报 COMPLETED、FAILED 或 SKIPPED 结果时才能继续下一步");

        Checklist checklist = lockOwned(sessionId, command.getChecklistId());
        ChecklistMutation mutation = checklist.changeStepStatus(command.getStepId(), next, command.isContinueNextStep());
        persist(checklist, mutation);
        return toVO(checklist);
    }

    @Override
    @Transactional
    public ChecklistVO modify(ChecklistCommand command) {
        throwIf(command == null, "清单参数不能为空");
        long sessionId = requireSessionId(command.getSessionId());

        Checklist checklist = lockOwned(sessionId, command.getChecklistId());
        ChecklistModification modification = new ChecklistModification(
                command.getNewTitle(),
                contentUpdates(command.getStepContents()),
                newSteps(command.getAddedSteps()),
                command.getRemovedStepIds(),
                command.getOrderedStepIds());
        ChecklistMutation mutation = checklist.applyModification(modification);
        persist(checklist, mutation);
        return toVO(checklist);
    }

    @Override
    @Transactional
    public ChecklistVO delete(ChecklistCommand command) {
        throwIf(command == null, "清单参数不能为空");
        long sessionId = requireSessionId(command.getSessionId());
        throwIf(command.getChecklistId() == null, "删除清单需要提供 checklistId");

        Checklist checklist = repository.findByIdForUpdate(command.getChecklistId())
                .orElseThrow(() -> new ClientException("清单 " + command.getChecklistId() + " 不存在"));
        checklist.requireSession(sessionId);
        if (checklist.getStatus().isDeleted()) {
            // 重复删除返回既有删除事实：删历史不能因为重试而变成错误
            return toVO(checklist);
        }
        ChecklistMutation mutation = checklist.softDelete(command.isCompleteOpenSteps());
        persist(checklist, mutation);
        log.info("软删执行清单: checklistId={}, sessionId={}", checklist.getId(), sessionId);
        return toVO(checklist);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ChecklistVO> findActive(long sessionId) {
        if (sessionId <= 0L) {
            return Optional.empty();
        }
        return repository.findActiveBySessionId(sessionId).map(this::toVO);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ChecklistVO> findCurrent(Long sessionId) {
        long owner = requireSessionId(sessionId);
        return repository.findCurrentBySessionId(owner).map(this::toVO);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ChecklistVO> findById(long sessionId, Long checklistId) {
        long owner = requireSessionId(sessionId);
        throwIf(checklistId == null, "按标识查询清单需要提供 checklistId");
        return repository.findByIdWithSteps(checklistId).map(checklist -> {
            // 审计口径与写入口一致：归属只认会话，不看状态，所以 DELETED 也能读、别的会话照样拒。
            checklist.requireSession(owner);
            return toVO(checklist);
        });
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<ChecklistVO> findLatestForDisplay(long sessionId) {
        long owner = requireSessionId(sessionId);
        return repository.findLatestBySessionId(owner).map(this::toVO);
    }

    @Override
    @Transactional
    public ReminderDecision remindOnNaturalComplete(ChecklistReminderContext context) {
        throwIf(context == null, "清单收尾上下文不能为空");
        long sessionId = requireSessionId(context.sessionId());
        Long executionId = context.executionId();
        throwIf(executionId == null || executionId <= 0L, "清单提醒缺少有效执行标识");
        Optional<Checklist> found = repository.findActiveBySessionIdForUpdate(sessionId);
        if (found.isEmpty()) {
            return ReminderDecision.noActiveChecklist();
        }
        Checklist checklist = found.get();
        checklist.requireSession(sessionId);

        if (!checklist.hasPendingSteps()) {
            // 理论上聚合在最后一步推进时就已收口；这里兜住历史脏数据，绝不向模型索要不存在的续轮
            if (checklist.complete()) {
                repository.updateChecklist(checklist);
            }
            return ReminderDecision.nothingPending(toVO(checklist));
        }

        reminderOwnership.requireAvailable(sessionId, executionId);
        if (checklist.reminderOwnedBy(executionId)
                && context.wasDelivered(checklist.getId(), checklist.getProgressVersion())) {
            checklist.markUnfinished();
            repository.updateChecklist(checklist);
            log.info("清单提醒额度用尽: checklistId={}, sessionId={}, progressVersion={}",
                    checklist.getId(), sessionId, checklist.getProgressVersion());
            return ReminderDecision.exhausted(toVO(checklist), "本进展版本已提醒过且仍无实际推进");
        }

        boolean replay = checklist.isReminderConsumed();
        if (!replay && !repository.claimReminder(checklist, executionId)) {
            Optional<Checklist> current = repository.findByIdForUpdate(checklist.getId());
            if (current.isEmpty() || current.get().getStatus().isTerminal()) {
                return ReminderDecision.noActiveChecklist();
            }
            current.get().requireSession(sessionId);
            throwIf(current.get().hasPendingSteps(), "清单提醒状态已变化，请重新执行收尾检查");
            current.get().complete();
            repository.updateChecklist(current.get());
            return ReminderDecision.nothingPending(toVO(current.get()));
        }

        checklist.applyReminderFact(executionId);
        if (replay) {
            repository.updateChecklist(checklist);
        }
        log.info("登记清单提醒: checklistId={}, sessionId={}, pending={}, replay={}",
                checklist.getId(), sessionId, checklist.pendingSteps().size(), replay);
        return replay ? ReminderDecision.replayed(toVO(checklist), pendingSteps(checklist))
                : ReminderDecision.reminded(toVO(checklist), pendingSteps(checklist));
    }

    /** 按聚合给出的变更面精确落库：先删、再改、最后插，避免顺序冲突。 */
    private void persist(Checklist checklist, ChecklistMutation mutation) {
        if (mutation.checklistChanged()) {
            try {
                // 状态回退和追加步骤都可能重新占用名额，必须让同一唯一索引裁决。
                repository.updateChecklist(checklist);
            } catch (DataIntegrityViolationException conflict) {
                if (checklist.getStatus() == ChecklistStatus.ACTIVE) {
                    throw new ClientException("当前会话已有活动清单，请先完成或删除它，再重新激活此清单", conflict);
                }
                throw conflict;
            }
        }
        for (Long stepId : mutation.removedStepIds()) {
            repository.deleteStep(stepId);
        }
        for (ChecklistStep step : mutation.changedSteps()) {
            repository.updateStep(step);
        }
        for (ChecklistStep step : mutation.addedSteps()) {
            repository.insertStep(step);
        }
    }

    /** 写入路径统一走带锁定位：checklistId 为空时用会话内的活动清单。 */
    private Checklist lockOwned(long sessionId, Long checklistId) {
        Checklist checklist = checklistId == null
                ? repository.findActiveBySessionIdForUpdate(sessionId)
                        .orElseThrow(() -> new ClientException("当前会话没有活动清单；编辑已收口清单请显式传入 checklistId，可先用 get_current_checklist 查询；没有清单时用 create_checklist 创建"))
                : repository.findByIdForUpdate(checklistId)
                        .orElseThrow(() -> new ClientException("清单 " + checklistId + " 不存在"));
        checklist.requireSession(sessionId);
        return checklist;
    }

    private Map<Long, String> contentUpdates(List<ChecklistCommand.StepContent> patches) {
        if (patches == null || patches.isEmpty()) {
            return Map.of();
        }
        Map<Long, String> updates = new LinkedHashMap<>();
        for (ChecklistCommand.StepContent patch : patches) {
            if (patch == null) {
                continue;
            }
            throwIf(patch.stepId() == null, "修改步骤内容需要提供 stepId");
            updates.put(patch.stepId(), patch.content());
        }
        return updates;
    }

    private List<ChecklistModification.NewStep> newSteps(List<String> contents) {
        if (contents == null || contents.isEmpty()) {
            return List.of();
        }
        List<ChecklistModification.NewStep> steps = new ArrayList<>();
        for (String content : contents) {
            steps.add(new ChecklistModification.NewStep(IdUtil.getSnowflakeNextId(), content));
        }
        return steps;
    }

    private List<ChecklistVO.StepVO> pendingSteps(Checklist checklist) {
        return checklist.pendingSteps().stream().map(this::toStepVO).toList();
    }

    private ChecklistVO toVO(Checklist checklist) {
        return ChecklistVO.builder()
                .checklistId(checklist.getId())
                .sessionId(checklist.getSessionId())
                .agentId(checklist.getAgentId())
                .title(checklist.getTitle())
                .status(checklist.getStatus().name())
                .remindStatus(checklist.isRemindStatus())
                .progressVersion(checklist.getProgressVersion())
                .createAt(checklist.getCreateAt())
                .updateAt(checklist.getUpdateAt())
                .steps(checklist.getSteps().stream()
                        .sorted(Comparator.comparingInt(ChecklistStep::getSeq))
                        .map(this::toStepVO)
                        .toList())
                .build();
    }

    private ChecklistVO.StepVO toStepVO(ChecklistStep step) {
        return ChecklistVO.StepVO.builder()
                .stepId(step.getId())
                .seq(step.getSeq())
                .content(step.getContent())
                .status(step.getStatus().name())
                .updateAt(step.getUpdateAt())
                .build();
    }

    private long requireSessionId(Long sessionId) {
        throwIf(sessionId == null || sessionId <= 0L, "清单必须归属一个会话");
        return sessionId;
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }
}
