package com.summit.dp.auth.domain.exception;
import com.summit.dp.shared.exception.ClientException;
public class AuthException extends ClientException {
    public AuthException(String message) {
        super(message);
    }
}
