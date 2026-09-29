package com.summit.dp.shared.exception;

public class ClientException extends RuntimeException {
    public ClientException(String message) {
        super(message);
    }
    public ClientException() {
        super("服务异常");
    }
}
