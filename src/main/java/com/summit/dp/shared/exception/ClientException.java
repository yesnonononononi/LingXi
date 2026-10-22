package com.summit.dp.shared.exception;

/**
 * 业务异常：message 是给用户看的文案，原因一律走 cause。
 * <p>只传 message 会把排查线索永久丢掉（如 MCP 连接失败的底层超时），
 * 因此凡有原始异常都必须用 {@link #ClientException(String, Throwable)}。</p>
 */
public class ClientException extends RuntimeException {
    public ClientException(String message) {
        super(message);
    }

    public ClientException(String message, Throwable cause) {
        super(message, cause);
    }

    public ClientException() {
        super("服务异常");
    }
}
