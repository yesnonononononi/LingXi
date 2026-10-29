package com.summit.dp.workflow.application.resume;

/** 轮次身份固定补充对象，请求身份保证断线重试不会重复投递。 */
public record ResumeSupplementCommand(Long turnId, String requestId, String input) { }
