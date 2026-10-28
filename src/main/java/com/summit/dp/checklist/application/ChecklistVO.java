package com.summit.dp.checklist.application;

import lombok.Builder;
import lombok.Data;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;

/** 内部写接口与界面复用权威快照；工具写回执单独裁剪，完整步骤仅在主动查询时返回。 */
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

    /** 按 seq 升序的步骤列表，避免调用方各自排序；不参与序列化，免得快照里出现两份步骤。 */
    @com.fasterxml.jackson.annotation.JsonIgnore
    public List<StepVO> sortedSteps() {
        if (steps == null) {
            return List.of();
        }
        return steps.stream().sorted(Comparator.comparingInt(StepVO::getSeq)).toList();
    }
}
