package com.summit.dp.model.application.vo;

import lombok.Builder;
import lombok.Data;

@Builder
@Data
public class ModelConfigVO {
    Long id;
    String modelName;
    String baseUrl;
    String apiKey;
}
