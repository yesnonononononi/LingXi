package com.summit.dp.sandbox_security.domain.model;

/** 保留命中规则，便于提示与审批复查。 */
public record SecurityDecision(SecurityAction action, String matchedRule) { }
