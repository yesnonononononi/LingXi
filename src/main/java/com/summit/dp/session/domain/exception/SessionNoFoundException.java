package com.summit.dp.session.domain.exception;

public class SessionNoFoundException extends RuntimeException {
    public SessionNoFoundException(String message) {
        super(message);
    }

    public SessionNoFoundException() {
        super("会话不存在");
    }
}
