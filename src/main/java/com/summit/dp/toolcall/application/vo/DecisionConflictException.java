package com.summit.dp.toolcall.application.vo;

/**
 * 带机器码的业务失败：{@code Result.errMsg} 给人读，{@code Result.code} 给机器判别。
 *
 * <p>刻意与 {@link com.summit.dp.shared.exception.ClientException} 分开而不是加个 code 字段：
 * 那个异常承载的是「没有更细分类」的业务失败（code 恒为 0），
 * 让它开始携带可枚举的码，最终会退化成「什么都能塞一个 -1 进来」，
 * 分类也就失去意义了。</p>
 *
 * <p><b>回执里同时带最新视图</b>：已决互动被另一命令争抢时，除了错误码还要把卡片的
 * 实际最新状态返回去 —— 只回一个错误码，前端还得再发一次查询才能知道现在是什么结论。</p>
 */
public class DecisionConflictException extends RuntimeException {

    private final DecisionErrorCode errorCode;
    private final transient Object latestView;

    public DecisionConflictException(DecisionErrorCode errorCode) {
        this(errorCode, errorCode.message(), null);
    }

    public DecisionConflictException(DecisionErrorCode errorCode, String message) {
        this(errorCode, message, null);
    }

    /**
     * @param errorCode  机器可判别业务码
     * @param message    面向用户的中文提示
     * @param latestView 冲突时的最新视图（{@code ToolCallVO} 或其投影）；可为 {@code null}
     */
    public DecisionConflictException(DecisionErrorCode errorCode, String message, Object latestView) {
        super(message);
        this.errorCode = errorCode;
        this.latestView = latestView;
    }

    public DecisionErrorCode errorCode() {
        return errorCode;
    }

    public Object latestView() {
        return latestView;
    }
}
