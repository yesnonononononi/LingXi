package com.summit.dp.checklist.application;

import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;

/**
 * 清单的权威快照。
 *
 * <p>所有写接口都返回完整快照（含稳定 stepId、seq、状态与进展版本），
 * 目的是让模型不需要再猜「现在还剩什么」——它刚写完就能看到权威结果。</p>
 */
@Data
@Builder
public class ChecklistVO {

    private Long checklistId;
    private Long sessionId;
    private Long agentId;
    private String title;
    private String status;
    /** 当前进展版本是否已用掉提醒额度 */
    private boolean remindStatus;
    /** 实际推进次数；结构修改不会递增 */
    private long progressVersion;
    private Instant createAt;
    private Instant updateAt;
    private List<StepVO> steps;

    /** 步骤快照：seq 只表示顺序，stepId 才是稳定标识。 */
    @Data
    @Builder
    public static class StepVO {
        private Long stepId;
        private int seq;
        private String content;
        private String status;
        private Instant updateAt;
    }

    /** 按 seq 升序的步骤列表，避免调用方各自排序。 */
    public List<StepVO> sortedSteps() {
        if (steps == null) {
            return List.of();
        }
        return steps.stream().sorted(Comparator.comparingInt(StepVO::getSeq)).toList();
    }
}
