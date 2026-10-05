package com.summit.dp.shared.config;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.domain.exception.SessionNoFoundException;
import com.summit.dp.shared.exception.AccessDeniedException;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.workspace.domain.exception.WorkspaceNoFoundException;
import jakarta.servlet.http.HttpServletResponse;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.io.IOException;

@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    /**
     * SSE 客户端主动断开时，Servlet 可能在异步派发阶段抛出 IOException。
     * 此时响应已是 text/event-stream，不能再写入普通 Result JSON。
     */
    @ExceptionHandler(IOException.class)
    public void handleClientDisconnect(IOException e) {
        log.debug("SSE/HTTP client disconnected: {}", e.getMessage());
    }

    /** 捕获缺失必填请求参数异常 */
    @ExceptionHandler(MissingServletRequestParameterException.class)
    public Result<Void> handleMissingParamException(MissingServletRequestParameterException e) {
        log.warn("【全局异常处理】缺少必要的请求参数: {}", e.getParameterName());
        return Result.error("缺少必要的请求参数: " + e.getParameterName());
    }

    /**
     * 越权访问：必须是独立 handler —— 若被父类 {@link ClientException} 的 handler 接住，
     * 响应会退化为 HTTP 200 + errMsg，前端无法与普通业务错误区分。
     *
     * <p><b>必须显式 setStatus(403)</b>：{@code @ResponseStatus} 只在异常未被 handler 处理、
     * 或 handler 返回 {@code ResponseEntity} 时才决定响应状态；一旦由 {@code @ExceptionHandler}
     * 方法返回普通 body，Spring 会固定回 200，注解被忽略。
     * 曾经只靠类上的 {@code @ResponseStatus}，结果实测为 HTTP 200 + {@code code:403}，
     * 因此这里直接写响应状态。</p>
     */
    @ExceptionHandler(AccessDeniedException.class)
    public Result<Void> handleAccessDenied(AccessDeniedException e,
                                           HttpServletResponse response) {
        log.warn("【全局异常处理】越权访问被拒: {}", e.getMessage());
        response.setStatus(HttpStatus.FORBIDDEN.value());
        return Result.error(403, e.getMessage());
    }

    /**
     * v2 决策冲突：必须回机器可判别业务码，而不是退化成 code 0 的普通文案。
     *
     * <p><b>为什么要独立 handler</b>：走 {@link ClientException} 那条路会得到 {@code code: 0}，
     * 前端无法把「版本冲突要刷新」「已决要采纳现有结论」「执行已结束要停止轮询」区分开，
     * 只能对中文做字符串匹配 —— 改一次文案就静默改坏行为。</p>
     */
    @ExceptionHandler(DecisionConflictException.class)
    public Result<Void> handleDecisionConflict(DecisionConflictException e) {
        log.warn("【全局异常处理】决策被拒: code={}, message={}", e.errorCode().code(), e.getMessage());
        return Result.error(e.errorCode().code(), e.getMessage());
    }

    /** 捕获业务异常 ClientException */
    @ExceptionHandler(ClientException.class)
    public Result<Void> handleClientException(ClientException e) {
        return Result.error(e.getMessage());
    }

    /**
     * 资源不存在：读取链路对「id 不存在」统一抛本异常（主键直查，查不到即抛），
     * 必须回 403 而不是 500。
     *
     * <p>若落进兜底 handler，不存在的 id 会表现为「系统繁忙，请稍后再试」——
     * 既把可判定的拒绝误报成服务器故障，也让调用方无法区分「不存在」与「真出错了」。</p>
     *
     * <p>与 {@link AccessDeniedException} 的关系：后者用于「请求内部自相矛盾」
     * （如互动状态与会话不匹配），本类用于「按 id 找不到资源」。对外都是 403。</p>
     */
    @ExceptionHandler({SessionNoFoundException.class, WorkspaceNoFoundException.class})
    public Result<Void> handleNotFound(RuntimeException e, HttpServletResponse response) {
        log.warn("【全局异常处理】资源不存在或无权访问: {}", e.getMessage());
        response.setStatus(HttpStatus.FORBIDDEN.value());
        return Result.error(403, e.getMessage());
    }

    /**
     * 未匹配到任何 handler：Spring Boot 3.2+ 会抛 {@link NoResourceFoundException}
     * （"No static resource xxx"），语义是 404。
     * 若不单独处理，会被兜底 handler 吞成 HTTP 200 + code:500，
     * 把"端点根本不存在"误报成"服务器故障"，也掩盖了已下线端点的验证结果。
     */
    @ExceptionHandler(NoResourceFoundException.class)
    public Result<Void> handleNoResource(NoResourceFoundException e,
                                         HttpServletResponse response) {
        log.warn("【全局异常处理】未匹配到资源: {}", e.getResourcePath());
        response.setStatus(HttpStatus.NOT_FOUND.value());
        return Result.error(404, "接口不存在");
    }

    /** 捕获系统兜底未知异常 */
    @ExceptionHandler(Exception.class)
    public Result<Void> handleException(Exception e, HttpServletResponse response) {
        log.error("【全局异常处理】系统异常: {}", e.getMessage(), e);
        response.setStatus(HttpStatus.INTERNAL_SERVER_ERROR.value());
        return Result.error(500, "系统繁忙，请稍后再试");
    }
}
