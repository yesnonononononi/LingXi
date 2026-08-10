package com.summit.dp.shared.utils;

import com.fasterxml.jackson.annotation.JsonFormat;
import io.swagger.v3.oas.annotations.media.Schema;
import lombok.*;

import java.time.Instant;
import java.util.Objects;

@Schema(description = "统一响应结果封装")
@AllArgsConstructor
@RequiredArgsConstructor
@Data
@EqualsAndHashCode
public class Result<T> {

    @Schema(description = "响应状态码(200成功, 0失败)", example = "200")
    final private int code;

    @Schema(description = "响应业务数据")
    final private T data;

    @Schema(description = "响应时间戳")
    final private Instant timestamp;

    private String errMsg;

    @Schema(description = "响应签名字符串")
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
