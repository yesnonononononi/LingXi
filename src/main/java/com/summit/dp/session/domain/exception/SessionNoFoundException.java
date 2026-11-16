package com.summit.dp.session.domain.exception;

import com.summit.dp.shared.exception.ClientException;

public class SessionNoFoundException extends ClientException {
    public SessionNoFoundException(String message) {
        super(message);
    }

    public SessionNoFoundException() {
        super("会话不存在");
    }
}
