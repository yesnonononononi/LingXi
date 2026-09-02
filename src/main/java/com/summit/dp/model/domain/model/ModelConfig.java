package com.summit.dp.model.domain.model;


import com.summit.ddd.domain.model.AggregateRoot;
import lombok.AllArgsConstructor;
import lombok.Getter;
@AllArgsConstructor
@Getter
public class ModelConfig extends AggregateRoot {
    private Long id;
    private String modelName;
    private String baseUrl;
    private String apiKey;

    public void update(String modelName, String baseUrl, String apiKey) {
        this.modelName = modelName;
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }

}
