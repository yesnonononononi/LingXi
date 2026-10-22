package com.summit.dp.model.application.command;

import java.util.List;

public record BatchModelCommand(Long providerConfigId, List<String> modelNames, Boolean vision) { }
