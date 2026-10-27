package com.summit.dp.checklist.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.Getter;

import java.time.Instant;
import java.util.Objects;

/**
 * 清单聚合内的步骤实体。
 *
 * <p>状态机只有一条前进边：{@code PENDING → COMPLETED/FAILED/SKIPPED}。
 * 重复提交同一个终态视为无变化（幂等，返回 {@code false}），
 * 这样重试不会白拿一次提醒额度；纠正错误的办法是新增步骤，而不是把已完成的步骤改回去。</p>
 *
 * <p>步骤标识稳定：改文案、重排序都不换 ID，模型与前端不能靠 seq 指代步骤。</p>
 */
@Getter
public final class ChecklistStep {

    private final Long id;
    private final Long checklistId;
    /** 展示顺序，从 1 开始；重排会重写它，但 ID 不变 */
    private int seq;
    private String content;
    private ChecklistStepStatus status;
    private Instant updateAt;

    private ChecklistStep(Long id, Long checklistId, int seq, String content,
                          ChecklistStepStatus status, Instant updateAt) {
        this.id = Objects.requireNonNull(id, "步骤标识不能为空");
        this.checklistId = Objects.requireNonNull(checklistId, "步骤必须归属一个清单");
        this.seq = seq;
        this.content = content;
        this.status = status;
        this.updateAt = updateAt;
    }

    /**
     * 新建一个待处理步骤。
     *
     * <p>标识由应用层用雪花算法生成：领域对象不依赖 ID 生成器，避免把基础设施的
     * 全局有序假设带进领域。</p>
     */
    public static ChecklistStep pending(Long id, Long checklistId, int seq, String content, Instant now) {
        return new ChecklistStep(id, checklistId, seq, ChecklistRules.normalizeStepContent(content),
                ChecklistStepStatus.PENDING, Objects.requireNonNullElseGet(now, ChecklistRules::now));
    }

    /** 仓储重建用：保留库里的原始状态与时间，不做任何校验性改写。 */
    public static ChecklistStep restore(Long id, Long checklistId, int seq, String content,
                                        ChecklistStepStatus status, Instant updateAt) {
        return new ChecklistStep(id, checklistId, seq, content, status, updateAt);
    }

    /**
     * 推进到终态。
     *
     * @return {@code true} 表示状态真的变了（调用方据此递增进展版本、重置提醒额度）；
     *         {@code false} 表示本次提交与现状相同，属于无变化
     */
    public boolean moveToTerminal(ChecklistStepStatus next) {
        if (next == null) {
            throw new ClientException("步骤状态不能为空");
        }
        if (!next.isTerminal()) {
            throw new ClientException("步骤不能退回待处理状态；需要重做时请新增一个步骤");
        }
        if (status == next) {
            return false;
        }
        if (status.isTerminal()) {
            throw new ClientException("已结束的步骤不能改为另一个终态；需要重做时请新增一个步骤");
        }
        status = next;
        updateAt = ChecklistRules.now();
        return true;
    }

    /**
     * 只改文案，保留原状态；不允许借改文案把终态步骤变回待处理。
     *
     * @return {@code true} 表示内容真的变了
     */
    boolean rename(String content) {
        String normalized = ChecklistRules.normalizeStepContent(content);
        if (normalized.equals(this.content)) {
            return false;
        }
        this.content = normalized;
        this.updateAt = ChecklistRules.now();
        return true;
    }

    /** 重排序只改 seq，ID 与状态都不动。 */
    void resequence(int seq) {
        if (this.seq == seq) {
            return;
        }
        this.seq = seq;
        this.updateAt = ChecklistRules.now();
    }

    /** 是否仍是待处理：提醒只关心这类步骤。 */
    public boolean isPending() {
        return status == ChecklistStepStatus.PENDING;
    }
}
