package com.summit.dp.device.domain;

/**
 * 危险动作的判定结论。dangerId 不在这里：它是"这一次求助"的标识，由调用方按会话生成，
 * 混进判定结果会让同一个判定无法复用。
 */
public record DangerVerdict(Risk risk, String reason) {

    public enum Risk { LOW, MEDIUM, HIGH }

    public DangerVerdict {
        if (risk == null) {
            throw new IllegalArgumentException("风险等级不能为空");
        }
        if (reason == null || reason.isBlank()) {
            throw new IllegalArgumentException("危险动作必须说明原因，否则用户无从判断该不该批准");
        }
    }
}
