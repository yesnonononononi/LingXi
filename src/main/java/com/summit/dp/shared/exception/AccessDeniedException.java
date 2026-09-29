package com.summit.dp.shared.exception;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.ResponseStatus;

/**
 * 越权访问异常：调用者不是资源归属人。
 *
 * <p>继承 {@link ClientException} 以便复用业务异常语义，但额外标注
 * {@link ResponseStatus} —— 框架的 {@code Result} 只承载业务码（{@code code/errMsg}），
 * 没有任何 HTTP 状态表达能力，靠注解让 Spring 把响应状态设为 403，
 * 前端才能与普通业务错误（HTTP 200 + errMsg）区分开。</p>
 *
 * <p>{@code GlobalExceptionHandler} 中有专用 handler（必须先于父类 ClientException
 * 语义生效），否则会被父类 handler 吞成 HTTP 200。</p>
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
