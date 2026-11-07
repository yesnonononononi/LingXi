package com.summit.dp.workflow.application.input;

/**
 * 注入阶段：同一批输入的文本协议在两处不同，靠这个枚举区分而不是各拼一份。
 *
 * <ul>
 *   <li>{@link #LOOP} —— 循环内每次模型调用前的注入（拦截器），文本面向「当前还在跑的轮次」；</li>
 *   <li>{@link #CONTINUATION} —— 执行正常结束后的新轮次合成，文本面向「接续处理新输入」。</li>
 * </ul>
 */
public enum InputInjectionStage {

    /** 循环内注入。 */
    LOOP,

    /** 终态跨轮次续跑。 */
    CONTINUATION
}
