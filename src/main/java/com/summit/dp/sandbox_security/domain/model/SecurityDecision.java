package com.summit.dp.sandbox_security.domain.model;

/** 保留命中规则，便于提示与审批复查。 */
public record SecurityDecision(SecurityAction action, String matchedRule, String matchType, String preset) {

    /** 面向模型与用户的说明：命中哪条规则、怎么匹配的、去哪里改。 */
    public String describe() {
        String kind = switch (matchType == null ? "" : matchType) {
            case "PROGRAM" -> "程序匹配";
            case "PREFIX" -> "命令前缀匹配";
            case "PATH" -> "路径匹配";
            case "ANY" -> "任意匹配";
            default -> matchType == null || matchType.isBlank() ? "规则匹配" : matchType;
        };
        String origin = preset == null || preset.isBlank() ? "自定义规则" : "预设规则 " + preset;
        return "命令被安全规则禁止：「" + matchedRule + "」（" + kind + "，" + origin
                + "）。可在「安全规则」设置中调整该规则。";
    }
}