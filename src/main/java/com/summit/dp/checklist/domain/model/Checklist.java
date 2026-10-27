package com.summit.dp.checklist.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.Builder;
import lombok.Getter;
import lombok.extern.slf4j.Slf4j;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * Agent 执行清单聚合根。
 *
 * <p><b>为什么需要它</b>：多步任务里模型容易在第 N 步就宣布「全部完成」。清单把「还剩什么没做」
 * 变成持久化事实，收尾时由服务端而不是模型来判定是否还有待处理步骤。</p>
 *
 * <p><b>不变量</b>（全部在这里守住，Service 只负责事务与锁）：</p>
 * <ul>
 *   <li>每个会话至多一份 ACTIVE 清单（由 init.sql 的派生列唯一索引兜底，这里不重复实现）</li>
 *   <li>只有 ACTIVE 可改；COMPLETED / UNFINISHED / DELETED 一律拒绝写入</li>
 *   <li>步骤只能 PENDING → 终态，且不能删光</li>
 *   <li>只有<b>实际</b>推进（PENDING → 终态）才递增 progressVersion 并重置提醒额度；
 *       改标题、改文案、增删重排都不重置，避免用结构修改无限换取续轮</li>
 *   <li>所有步骤都不再 PENDING 时清单自动收口为 COMPLETED（FAILED / SKIPPED 不阻止收口）</li>
 * </ul>
 */
@Slf4j
@Getter
public class Checklist {

    private final Long id;
    private final Long sessionId;
    /** 创建清单的 Agent：仅作记录，不参与归属判定（归属永远是 sessionId） */
    private final Long agentId;
    private String title;
    private ChecklistStatus status;
    /** 当前 progressVersion 是否已经用掉提醒额度 */
    private boolean remindStatus;
    /** 步骤实际推进次数；结构修改不递增 */
    private long progressVersion;
    /** 提醒归属执行：用于区分「本次执行已提醒」与「其他执行持有提醒」 */
    private Long remindExecutionId;
    /** 提醒发生时的进展版本：与 progressVersion 相等才说明提醒之后没有任何实际推进 */
    private Long remindedProgressVersion;
    private final Instant createAt;
    private Instant updateAt;
    private final List<ChecklistStep> steps;

    @Builder
    private Checklist(Long id, Long sessionId, Long agentId, String title, ChecklistStatus status,
                      boolean remindStatus, long progressVersion, Long remindExecutionId,
                      Long remindedProgressVersion, Instant createAt, Instant updateAt,
                      List<ChecklistStep> steps) {
        this.id = id;
        this.sessionId = sessionId;
        this.agentId = agentId;
        this.title = title;
        this.status = Objects.requireNonNullElse(status, ChecklistStatus.ACTIVE);
        this.remindStatus = remindStatus;
        this.progressVersion = progressVersion;
        this.remindExecutionId = remindExecutionId;
        this.remindedProgressVersion = remindedProgressVersion;
        this.createAt = Objects.requireNonNullElseGet(createAt, ChecklistRules::now);
        this.updateAt = Objects.requireNonNullElseGet(updateAt, () -> this.createAt);
        this.steps = new ArrayList<>(Objects.requireNonNullElse(steps, List.of()));
    }

    /**
     * 新建一份清单。
     *
     * <p>步骤标识由应用层生成后传入：ID 生成器属于基础设施，领域只保证结构与状态不变量。</p>
     */
    public static Checklist create(Long id, Long sessionId, Long agentId, String title,
                                   List<ChecklistStep> steps, Instant now) {
        Objects.requireNonNull(id, "清单标识不能为空");
        Objects.requireNonNull(sessionId, "清单必须归属一个会话");
        List<ChecklistStep> normalized = new ArrayList<>(Objects.requireNonNullElse(steps, List.of()));
        ChecklistRules.requireStepCount(normalized.size());
        for (ChecklistStep step : normalized) {
            if (!step.isPending()) {
                throw new ClientException("新建清单的步骤必须全部为待处理状态");
            }
        }
        Instant timestamp = Objects.requireNonNullElseGet(now, ChecklistRules::now);
        for (int index = 0; index < normalized.size(); index++) {
            normalized.get(index).resequence(index + 1);
        }
        return Checklist.builder()
                .id(id)
                .sessionId(sessionId)
                .agentId(agentId)
                .title(ChecklistRules.normalizeTitle(title))
                .status(ChecklistStatus.ACTIVE)
                .remindStatus(false)
                .progressVersion(0L)
                .steps(normalized)
                .createAt(timestamp)
                .updateAt(timestamp)
                .build();
    }

    /** 仓储重建：完全按库里的值还原，不做状态重算，否则读一次就可能改写事实。 */
    public static Checklist restore(Long id, Long sessionId, Long agentId, String title,
                                    ChecklistStatus status, boolean remindStatus, long progressVersion,
                                    Long remindExecutionId, Long remindedProgressVersion,
                                    Instant createAt, Instant updateAt, List<ChecklistStep> steps) {
        return Checklist.builder()
                .id(id).sessionId(sessionId).agentId(agentId).title(title).status(status)
                .remindStatus(remindStatus).progressVersion(progressVersion)
                .remindExecutionId(remindExecutionId).remindedProgressVersion(remindedProgressVersion)
                .createAt(createAt).updateAt(updateAt).steps(steps)
                .build();
    }

    /** 只读快照：调用方不能借返回的集合改聚合内部状态。 */
    public List<ChecklistStep> getSteps() {
        return List.copyOf(steps);
    }

    /** 仍是待处理的步骤，按 seq 升序；提醒文案直接用它。 */
    public List<ChecklistStep> pendingSteps() {
        return steps.stream().filter(ChecklistStep::isPending)
                .sorted((left, right) -> Integer.compare(left.getSeq(), right.getSeq()))
                .toList();
    }

    /** 是否还有未处理步骤：收尾判定的唯一依据。 */
    public boolean hasPendingSteps() {
        return steps.stream().anyMatch(ChecklistStep::isPending);
    }

    /**
     * 推进一个步骤到终态。
     *
     * @return 本次变更需要落库的影响面；重复提交相同终态时返回 {@link ChecklistMutation#none()}
     */
    public ChecklistMutation changeStepStatus(long stepId, ChecklistStepStatus next) {
        ChecklistStep step = requireStep(stepId);
        // 已收口后的同状态重试只读取既有事实，不能借此重新打开清单。
        if (status == ChecklistStatus.COMPLETED && step.getStatus() == next) {
            return ChecklistMutation.none();
        }
        requireActive("更新步骤");
        if (!step.moveToTerminal(next)) {
            // 无变化：不递增版本、不重置提醒额度，也不刷新清单时间——重试必须完全等价于没发生
            return ChecklistMutation.none();
        }
        progressVersion++;
        resetReminderQuota();
        recomputeStatus();
        touch();
        log.debug("清单步骤推进: checklistId={}, stepId={}, status={}, progressVersion={}",
                id, stepId, next, progressVersion);
        return new ChecklistMutation(true, List.of(), List.of(step), List.of());
    }

    /**
     * 应用一次结构修改补丁。
     *
     * <p>分两段：<b>先把结果算完并校验</b>（删哪些、改哪些、加哪些、新顺序），
     * 全部合法后才真正改动聚合。这样任何一条校验失败都不会留下「删了一半」的脏对象 ——
     * 事务回滚能救数据库，救不了内存里的聚合。</p>
     */
    public ChecklistMutation applyModification(ChecklistModification modification) {
        requireActive("修改清单");
        ChecklistModification patch = Objects.requireNonNullElseGet(modification, ChecklistModification::empty);

        // ---- 第一段：只校验与计算，不改聚合 ----
        String nextTitle = title;
        if (patch.title() != null) {
            nextTitle = ChecklistRules.normalizeTitle(patch.title());
        }

        Set<Long> removedStepIds = new LinkedHashSet<>(distinct(patch.removedStepIds()));
        for (Long stepId : removedStepIds) {
            requireStep(stepId);
        }

        Map<Long, String> contentUpdates = new LinkedHashMap<>();
        if (patch.contentUpdates() != null) {
            for (Map.Entry<Long, String> entry : patch.contentUpdates().entrySet()) {
                if (entry.getKey() == null) {
                    throw new ClientException("修改步骤内容必须给出步骤标识");
                }
                ChecklistStep step = requireStep(entry.getKey());
                contentUpdates.put(entry.getKey(), ChecklistRules.normalizeStepContent(entry.getValue()));
                // 归一化后与现状相同的项直接丢弃，它们不构成变更
                if (contentUpdates.get(entry.getKey()).equals(step.getContent())) {
                    contentUpdates.remove(entry.getKey());
                }
            }
        }

        List<ChecklistStep> addedSteps = new ArrayList<>();
        if (patch.addedSteps() != null) {
            for (ChecklistModification.NewStep newStep : patch.addedSteps()) {
                if (newStep == null || newStep.id() == null) {
                    throw new ClientException("新增步骤必须给出步骤标识");
                }
                addedSteps.add(ChecklistStep.pending(newStep.id(), id, 0, newStep.content(), ChecklistRules.now()));
            }
        }

        List<ChecklistStep> nextOrder = new ArrayList<>(steps.stream()
                .filter(step -> !removedStepIds.contains(step.getId()))
                .toList());
        nextOrder.addAll(addedSteps);
        // 删光即非法：空清单无法承载任何进展，只会白占唯一额度
        ChecklistRules.requireStepCount(nextOrder.size());
        if (patch.orderedStepIds() != null && !patch.orderedStepIds().isEmpty()) {
            nextOrder = reorder(nextOrder, patch.orderedStepIds());
        }

        // ---- 第二段：校验全过，落改动 ----
        boolean checklistChanged = false;
        if (!nextTitle.equals(title)) {
            title = nextTitle;
            checklistChanged = true;
        }
        Set<ChecklistStep> changedSteps = new LinkedHashSet<>();
        for (Map.Entry<Long, String> entry : contentUpdates.entrySet()) {
            ChecklistStep step = requireStep(entry.getKey());
            if (step.rename(entry.getValue())) {
                changedSteps.add(step);
                checklistChanged = true;
            }
        }
        if (!removedStepIds.isEmpty() || !addedSteps.isEmpty()) {
            checklistChanged = true;
        }
        for (int index = 0; index < nextOrder.size(); index++) {
            int target = index + 1;
            if (nextOrder.get(index).getSeq() != target) {
                nextOrder.get(index).resequence(target);
                if (!addedSteps.contains(nextOrder.get(index))) {
                    changedSteps.add(nextOrder.get(index));
                }
                checklistChanged = true;
            }
        }
        for (ChecklistStep added : addedSteps) {
            changedSteps.remove(added);
        }
        steps.clear();
        steps.addAll(nextOrder);

        if (recomputeStatus()) {
            checklistChanged = true;
        }
        if (checklistChanged) {
            touch();
        }
        return new ChecklistMutation(checklistChanged, List.copyOf(removedStepIds),
                List.copyOf(changedSteps), List.copyOf(addedSteps));
    }

    /**
     * 把清单收口为 COMPLETED。
     *
     * @return {@code true} 表示状态真的从 ACTIVE 变了
     */
    public boolean complete() {
        if (status != ChecklistStatus.ACTIVE) {
            return false;
        }
        status = ChecklistStatus.COMPLETED;
        touch();
        return true;
    }

    /**
     * 无实际推进的收尾：ACTIVE → UNFINISHED，把唯一额度让给下一份清单。
     *
     * <p>不删除现场：未完成的步骤要留证据，不能伪装成已完成。</p>
     */
    public void markUnfinished() {
        if (status != ChecklistStatus.ACTIVE) {
            throw new ClientException("只有执行中的清单才能标记为未完成，当前状态 " + status);
        }
        status = ChecklistStatus.UNFINISHED;
        touch();
    }

    /** 软删：任何未删除状态都可删除；已删除的重复删除按幂等处理（由 Service 决定是否报错）。 */
    public void softDelete() {
        if (status.isDeleted()) {
            throw new ClientException("清单已删除");
        }
        status = ChecklistStatus.DELETED;
        touch();
    }

    /**
     * CAS 成功后同步内存里的提醒事实。
     *
     * <p>数据库条件更新是权威，这里只保证返回给调用方的快照与库一致。</p>
     */
    public void applyReminderFact(Long executionId) {
        this.remindStatus = true;
        this.remindExecutionId = executionId;
        this.remindedProgressVersion = progressVersion;
        touch();
    }

    /** 提醒是否已被本执行在同一进展版本上用掉。 */
    public boolean reminderOwnedBy(Long executionId) {
        return remindStatus && Objects.equals(remindExecutionId, executionId)
                && Objects.equals(remindedProgressVersion, progressVersion);
    }

    /** 提醒额度是否已被某个执行占用（不区分归属）。 */
    public boolean isReminderConsumed() {
        return remindStatus;
    }

    /** 当前处于 ACTIVE 才允许写操作。 */
    public void requireActive(String action) {
        if (status != ChecklistStatus.ACTIVE) {
            throw new ClientException("清单当前状态为 " + status + "，不能" + action
                    + "；需要继续工作请新建清单");
        }
    }

    /** 是否属于给定会话：跨会话访问一律拒绝。 */
    public void requireSession(long expectedSessionId) {
        if (!Objects.equals(sessionId, expectedSessionId)) {
            throw new ClientException("清单不属于当前会话，拒绝访问");
        }
    }

    private ChecklistStep requireStep(long stepId) {
        Optional<ChecklistStep> found = steps.stream().filter(step -> step.getId() != null
                && step.getId() == stepId).findFirst();
        return found.orElseThrow(() -> new ClientException("步骤 " + stepId + " 不属于该清单"));
    }

    /** 按调用方给出的完整标识序列重排候选集合；必须恰好覆盖，否则拒绝。 */
    private List<ChecklistStep> reorder(List<ChecklistStep> candidates, List<Long> orderedStepIds) {
        List<Long> wanted = distinct(orderedStepIds);
        if (wanted.size() != candidates.size()) {
            throw new ClientException("重排序必须给出清单里全部 " + candidates.size() + " 个步骤，不能遗漏或重复");
        }
        List<ChecklistStep> ordered = new ArrayList<>();
        for (Long stepId : wanted) {
            ChecklistStep step = candidates.stream()
                    .filter(candidate -> candidate.getId() != null && candidate.getId().equals(stepId))
                    .findFirst()
                    .orElseThrow(() -> new ClientException("重排序里的步骤 " + stepId + " 不属于该清单"));
            ordered.add(step);
        }
        return ordered;
    }

    /** 所有步骤都不再待处理即收口；FAILED / SKIPPED 是步骤级结果，不阻止收口。 */
    private boolean recomputeStatus() {
        if (status != ChecklistStatus.ACTIVE || hasPendingSteps()) {
            return false;
        }
        status = ChecklistStatus.COMPLETED;
        return true;
    }

    private void resetReminderQuota() {
        remindStatus = false;
        remindExecutionId = null;
        remindedProgressVersion = null;
    }

    private void touch() {
        updateAt = ChecklistRules.now();
    }

    private static List<Long> distinct(Collection<Long> ids) {
        if (ids == null || ids.isEmpty()) {
            return List.of();
        }
        Set<Long> unique = new LinkedHashSet<>();
        for (Long id : ids) {
            if (id == null) {
                throw new ClientException("步骤标识不能为空");
            }
            unique.add(id);
        }
        return List.copyOf(unique);
    }
}
