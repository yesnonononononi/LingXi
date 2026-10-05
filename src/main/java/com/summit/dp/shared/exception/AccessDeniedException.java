package com.summit.dp.shared.exception;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

/**
 * 越权访问异常：调用者不是资源归属人。
 *
 * <p>继承 {@link ClientException} 以便复用业务异常语义，但额外标注
 * {@link ResponseStatus} —— 框架的 {@code Result} 只承载业务码（{@code code/errMsg}），
 */
@ResponseStatus(HttpStatus.FORBIDDEN)
public class AccessDeniedException extends ClientException {

    public AccessDeniedException() {
        super("无权访问该资源");
    }

    public AccessDeniedException(String message) {
        super(message);
    }
}
