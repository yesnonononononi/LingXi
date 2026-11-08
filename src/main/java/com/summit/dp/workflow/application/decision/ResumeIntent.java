package com.summit.dp.workflow.application.decision;

/**
 * 决策落库后「恢复意图由谁登记」。
 *
 * <p>v2 与多选批量在决策事务内登记（{@code execution_resume_task} 与结论同批提交）；
 * v1 的恢复必须与它自己的 SSE 生命周期绑在一起（先连上、恢复跑完才关流），
 * 因此由入口在提交之后自行恢复。</p>
 */
public enum ResumeIntent {

    /** 事务内登记恢复意图，派发排在事务提交之后。 */
    COORDINATOR,

    /** 入口自行恢复（v1：恢复跑完才关流，时序是契约的一部分）。 */
    ENTRY_MANAGED
}
