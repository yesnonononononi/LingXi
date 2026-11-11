package com.summit.dp.session.application.port;

import java.util.Collection;

/**
 * 会话删除前的执行侧闸门。
 *
 * <p><b>为什么删除必须先问执行</b>：会话行一删，仍在跑的线程并不知情 —— 它收尾时会保存检查点、
 * 写工具卡片、落终态执行行。这些行全部指向一个已经消失的会话，谁也不会再来清理它们。</p>
 *
 * <p><b>为什么是拒绝而不是「顺手停掉」</b>：停止是异步的，取消信号发出后线程还要跑一段收尾，
 * 删除动作等不到它；要么阻塞等一个不确定的时间，要么留下竞态。直接拒绝最诚实：前端本来就不允许
 * 删除运行中的会话（{@code isSessionActive}），后端把同一条规则变成硬约束。</p>
 */
public interface SessionDeletionGuard {

    /**
     * 会话树里还有正在跑的执行就抛业务异常。
     *
     * <p>只拦「真的还有线程」的状态：{@code RUNNING} 与刚受理的 {@code CREATED}。
     * {@code SUSPENDED} 不拦 —— 挂起的执行没有任何线程在写，删掉会话正等于放弃这次挂起。</p>
     *
     * @param sessionIds 整棵会话树的会话 id
     * @throws com.summit.dp.shared.exception.ClientException 仍有执行在跑
     */
    void requireNoRunningExecution(Collection<Long> sessionIds);
}
