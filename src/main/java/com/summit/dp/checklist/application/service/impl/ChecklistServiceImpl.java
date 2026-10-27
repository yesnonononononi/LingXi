package com.summit.dp.checklist.application.service.impl;

import cn.hutool.core.util.IdUtil;
import com.summit.dp.checklist.application.ChecklistCommand;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistVO;
import com.summit.dp.checklist.application.ReminderDecision;
import com.summit.dp.checklist.domain.model.Checklist;
import com.summit.dp.checklist.domain.model.ChecklistModification;
import com.summit.dp.checklist.domain.model.ChecklistMutation;
import com.summit.dp.checklist.domain.model.ChecklistRules;
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

/**
 * 清单应用服务实现。
 *
 * <p><b>为什么所有写操作都在这里</b>：清单是聚合，步骤状态、清单状态与提醒字段必须一起提交。
 * 让 Executor 直接改步骤会绕过父行锁，于是「推进步骤」和「无进展收口」可以同时成立，
 * 这就是计划书里点名要避免的半聚合写入。</p>
 *
 * <p>事务内顺序固定：<b>锁父行 → 读步骤 → 跑聚合方法 → 按变更面精确落库</b>。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ChecklistServiceImpl implements ChecklistService {

    private final ChecklistRepository repository;

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

        Checklist checklist = lockOwned(sessionId, command.getChecklistId());
        ChecklistMutation mutation = checklist.changeStepStatus(command.getStepId(), next);
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
        checklist.softDelete();
        repository.updateChecklist(checklist);
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
    @Transactional
    public ReminderDecision remindOnNaturalComplete(long sessionId, Long executionId) {
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

        if (!repository.claimReminder(checklist.getId(), executionId)) {
            // 条件更新 0 行：本进展版本的额度已被用掉（本执行上一轮，或已接管的旧执行）
            checklist.markUnfinished();
            repository.updateChecklist(checklist);
            log.info("清单提醒额度用尽: checklistId={}, sessionId={}, progressVersion={}",
                    checklist.getId(), sessionId, checklist.getProgressVersion());
            return ReminderDecision.exhausted(toVO(checklist), "本进展版本已提醒过且仍无实际推进");
        }

        // CAS 已经把归属执行与提醒版本写进库里，这里只同步内存快照
        checklist.applyReminderFact(executionId);
        log.info("发送清单提醒: checklistId={}, sessionId={}, pending={}",
                checklist.getId(), sessionId, checklist.pendingSteps().size());
        return ReminderDecision.reminded(toVO(checklist), pendingSteps(checklist));
    }

    /** 按聚合给出的变更面精确落库：先删、再改、最后插，避免顺序冲突。 */
    private void persist(Checklist checklist, ChecklistMutation mutation) {
        if (mutation.checklistChanged()) {
            repository.updateChecklist(checklist);
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
                        .orElseThrow(() -> new ClientException("当前会话没有活动清单，请先用 create_checklist 创建"))
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
