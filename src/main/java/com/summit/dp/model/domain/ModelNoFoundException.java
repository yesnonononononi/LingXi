package com.summit.dp.model.domain;

import com.summit.dp.shared.exception.ClientException;

public class ModelNoFoundException extends ClientException {
    public ModelNoFoundException(String message) {
        super(message);
    }
    public ModelNoFoundException() {
        super("未找到模型");
    }
}
