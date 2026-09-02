package com.summit.dp.shared.config.exception;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.exception.ClientException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * 捕获缺失必填请求参数异常
     */
    @ExceptionHandler(MissingServletRequestParameterException.class)
    public Result<Void> handleMissingParamException(MissingServletRequestParameterException e) {
        log.warn("【全局异常处理】缺少必要的请求参数: {}", e.getParameterName());
        return Result.error("缺少必要的请求参数: " + e.getParameterName());
    }

    /**
     * 捕获业务异常 ClientException
     */
    @ExceptionHandler(ClientException.class)
    public Result<Void> handleClientException(ClientException e) {
        return Result.error(e.getMessage());
    }

    /**
     * 捕获系统兜底未知异常
     */
    @ExceptionHandler(Exception.class)
    public Result<Void> handleException(Exception e) {
        log.error("【全局异常处理】系统异常: {}", e.getMessage(), e);
        return Result.error(500, "系统繁忙，请稍后再试");
    }
}
