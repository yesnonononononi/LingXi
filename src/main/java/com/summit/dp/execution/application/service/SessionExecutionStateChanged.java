package com.summit.dp.execution.application.service;

/** 只在执行状态实际迁移时通知，检查点内容刷新不重复置未读。 */
public record SessionExecutionStateChanged(Long sessionId) { }
