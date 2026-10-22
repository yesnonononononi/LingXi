package com.summit.dp.model.application.vo;

import java.util.List;

public record BatchModelResult(int addedCount, List<String> skippedNames) { }
