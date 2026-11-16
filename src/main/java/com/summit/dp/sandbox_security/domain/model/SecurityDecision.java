package com.summit.dp.sandbox_security.domain.model;

/** 保留命中规则，便于提示与审批复查。 */
public record SecurityDecision(SecurityAction action, String matchedRule, String matchType, String preset) {

    /** 面向模型与用户的说明：命中哪条规则、怎么匹配的、去哪里改。 */
    public String describe() {
        return "命令被安全规则禁止：「" + matchedRule + "」（" + resolveKind() + "，" + resolveOrigin()
                + "）。可在「安全规则」设置中调整该规则。";
    }

    /**
     * 文件访问被拒的说明。
     *
     * <p>与命令共用同一套口径，但必须说清是哪个路径 —— 只说「被禁止」，模型分不清是工作区边界
     * 还是隐私目录规则，用户改规则时也无从下手。</p>
     *
     * @param target 本次访问的路径（模型下发的原文）
     */
    public String describeFile(String target) {
        return "文件访问被安全规则禁止：「" + matchedRule + "」（" + resolveKind() + "，" + resolveOrigin()
                + "），目标路径 " + target + "。可在「安全规则」设置中调整该规则。";
    }

    private String resolveKind() {
        return switch (matchType == null ? "" : matchType) {
            case "PROGRAM" -> "程序匹配";
            case "PREFIX" -> "命令前缀匹配";
            case "PATH" -> "路径匹配";
            case "ANY" -> "任意匹配";
            default -> matchType == null || matchType.isBlank() ? "规则匹配" : matchType;
        };
    }

    private String resolveOrigin() {
        return preset == null || preset.isBlank() ? "自定义规则" : "预设规则 " + preset;
    }
}
