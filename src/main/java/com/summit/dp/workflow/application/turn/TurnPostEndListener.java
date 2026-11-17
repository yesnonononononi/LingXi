package com.summit.dp.workflow.application.turn;

/**
 * 一轮执行结束后的后置处理扩展点。
 *
 * <p>实现类各自管一个模块（待发送队列、邮件续跑……），由 {@link TurnPostEndProcessor} 按
 * {@link #order()} 升序依次调用。**不要在实现里假设自己独占**：别人可能已经在前面改过状态。</p>
 *
 * <p>约定：实现抛出的异常会被处理器吞掉并记 error 日志。需要让用户看见的失败，
 * 自己写进自己的权威事实（待发送队列写 failure 列），别指望上抛。</p>
 */
public interface TurnPostEndListener {

    /** 越小越先。业务侧从 -900 起分段，不要都取 0 —— 并列时顺序取决于注入顺序，不可依赖。 */
    int order();

    /** 调用时上一轮已经成为事实：上下文已回写、运行资格已释放、会话锁已退出。 */
    void onTurnEnded(TurnPostEndContext context);
}
