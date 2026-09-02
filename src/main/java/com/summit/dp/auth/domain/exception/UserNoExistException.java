package com.summit.dp.auth.domain.exception;

import com.summit.dp.shared.exception.ClientException;

public class UserNoExistException extends ClientException {
    public UserNoExistException(String message) {
        super(message);
    }
    public UserNoExistException() {
        super("用户不存在");
    }
}
