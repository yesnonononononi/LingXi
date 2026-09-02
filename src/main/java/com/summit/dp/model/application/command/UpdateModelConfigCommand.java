package com.summit.dp.model.application.command;

public record UpdateModelConfigCommand (
        Long id,
        String modelName,
        String baseUrl,
        String apiKey
){
}
