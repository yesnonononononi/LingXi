package com.summit.dp.model.application.command;

public record  ModelConfigCommand (
        Long id,
        String modelName,
        String baseUrl,
        String apiKey
){
}
