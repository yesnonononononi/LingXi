package com.summit.dp.shared.utils;

import lombok.*;

import java.time.Instant;
import java.util.Objects;

@AllArgsConstructor
@RequiredArgsConstructor
@Data
@EqualsAndHashCode
public class Result<T> {
    final private int code;
    final private T data;
    final private Instant timestamp;
    private String errMsg;
    private String signStr;


    public static <T> Result<T> success(Integer code, T data) {
        code = Objects.requireNonNullElse(code, 200);
        return new Result<>(code, data, Instant.now());
    }

    public static <T> Result<T> success(Integer code) {
        code = Objects.requireNonNullElse(code, 200);
        return new Result<>(code, null, Instant.now());
    }

    public static <T> Result<T> success(T data) {
        return new Result<>(200, data, Instant.now());
    }

    public static <T> Result<T> success() {
        return new Result<>(200, null, Instant.now());
    }

    public static <T> Result<T> error(Integer code, String errMsg) {
        code = Objects.requireNonNullElse(code, 0);
        return new Result<>(code, null, Instant.now(), errMsg, null);
    }

    public static <T> Result<T> error(String errMsg) {
        return new Result<>(0, null, Instant.now(), errMsg, null);
    }

    public static <T> Result<T> error(Integer code) {
        code = Objects.requireNonNullElse(code, 0);
        return new Result<>(code, null, Instant.now(), null, null);
    }

    public static <T> Result<T> error() {
        return new Result<>(0, null, Instant.now(), null, null);
    }


}
