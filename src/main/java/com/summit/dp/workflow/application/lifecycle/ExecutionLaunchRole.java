package com.summit.dp.workflow.application.lifecycle;

/**
 * 启动失败收口的三种口径。
 *
 * <p><b>为什么不能一套规则打天下</b>：挂起态对根会话与子代理意味着「还能恢复」，
 * 对恢复本身却意味着「已批准但没起步」—— 后者必须收口，照抄前者的跳过分支就永远收不了口。
 * 子代理又比根会话更严：子 loop 一旦跑起来，框架已经 fail 过，业务侧再补一次会撞上
 * 「非法状态转换」，所以它只收还没开跑的 {@code CREATED}。</p>
 */
public enum ExecutionLaunchRole {

    /** 根会话新执行：终态与挂起态都不覆盖（挂起可恢复），CREATED / RUNNING 可收。 */
    ROOT,

    /** 协作式子执行：只收 {@code CREATED}；已开跑的失败由框架自己收口。 */
    SUB_AGENT,

    /** 恢复启动：连挂起态也要收口。 */
    RESUME
}
