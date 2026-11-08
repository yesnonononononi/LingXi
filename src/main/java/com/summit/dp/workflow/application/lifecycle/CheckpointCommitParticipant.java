package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;

/**
 * 检查点提交参与方：仓储保存检查点时把「事务内」与「提交后」两段交给业务侧。
 *
 * <p>存在的理由是边界：{@code LocalExecutionRepository} 只该管检查点读写、重试与文件回收。
 * 邮件回执、运行登记、终态收口都是业务事实，写在仓储里会让一个存储组件同时成为编排器。</p>
 *
 * <p><b>两段的事务语义不同，不可互换</b>：</p>
 * <ul>
 *   <li>{@link #inTransaction} 在保存检查点的那次事务里执行，失败即整笔回滚。</li>
 *   <li>{@link #afterCommit} 在事务提交之后执行，失败不回滚已提交的检查点。</li>
 * </ul>
 */
public interface CheckpointCommitParticipant {

    /**
     * 与检查点同批提交的动作。
     *
     * <p>实现必须只做「错了就该整笔回滚」的事。把可容忍失败的动作放进来，会让一次瞬时失败
     * 连带丢掉已经写好的检查点。</p>
     *
     * @param execution 本次保存的执行（含已注入的属性，如本轮已投递的邮件 id）
     */
    void inTransaction(Execution execution);

    /**
     * 提交之后的通知：登记、收口脚本之类的派生副作用。
     *
     * @param execution 本次保存的执行
     * @param facts     本次保存的生命周期事实
     */
    void afterCommit(Execution execution, ExecutionSaveFacts facts);
}
