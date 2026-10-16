package com.summit.dp.sandbox_security.domain.model;

/** 并发保存必须显式失败，不能覆盖用户尚未看到的新配置。 */
public final class SecurityRevisionConflictException extends IllegalStateException {
    public SecurityRevisionConflictException() { super("安全规则已被其他窗口修改，请重新加载后再保存"); }
}
