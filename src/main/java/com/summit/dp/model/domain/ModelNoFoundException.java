package com.summit.dp.model.domain;

public class ModelNoFoundException extends RuntimeException {
    public ModelNoFoundException(String message) {
        super(message);
    }
    public ModelNoFoundException() {
        super("未找到模型");
    }
}
