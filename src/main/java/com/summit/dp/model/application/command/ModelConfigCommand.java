package com.summit.dp.model.application.command;

/** 模型配置通用命令：新增(add)与更新(update)共用； 更新时依据 id 定位记录，modelName/baseUrl/apiKey 为待写入字段。 */
public record  ModelConfigCommand (
        Long id,
        String modelName,
        String baseUrl,
        String apiKey
){
}
