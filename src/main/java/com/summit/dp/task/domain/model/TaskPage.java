package com.summit.dp.task.domain.model;

import java.util.List;

/** 分页事实不依赖持久化框架。 */
public record TaskPage(long current, long size, long total, List<Task> records) { }
