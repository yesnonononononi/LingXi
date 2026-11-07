package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;

import java.util.concurrent.ExecutorService;
import java.util.function.BooleanSupplier;

/**
 * 一次启动请求：把根会话与子代理两条启动链的差异全部声明在数据里。
 *
 * <p><b>为什么用同一个类型</b>：两条链共享同一套模板 —— 准入 → 提交到角色专属线程池 →
 * 没能起步时按角色收口。差异只有四点（角色、线程池、准入判据、没能起步时撤销哪份登记），
 * 把它们放进数据、模板只写一次，才不会出现「根补了提交失败收口、子忘了补」这种单边修复。</p>
 *
 * <p><b>角色差异必须保留</b>：根的准入是「运行资格已由受理脚本拿到」（提交时恒真），
 * 没能起步时释放的是 {@code finishRoot}；子的准入是抢登记 {@code tryStartChild}，
 * 没能起步时撤销的是 {@code revokeChild}。两者的线程池也各自独立 ——
 * 合成一个池会让根的单飞资格与子的孤儿回收互相影响。</p>
 *
 * @param role           启动角色，决定启动失败收口的口径
 * @param executor       角色专属线程池
 * @param execution      本次启动的执行；子代理在提交时还没建执行，允许为 {@code null}
 * @param admission      准入判据，在角色线程池里求值，返回 {@code false} 表示不开跑
 * @param onUnstarted    没能起步时的登记撤销（准入被拒或提交被拒都走它）
 * @param body           真正开跑的工作
 */
public record ExecutionLaunchSpec(ExecutionLaunchRole role,
                                  ExecutorService executor,
                                  Execution execution,
                                  BooleanSupplier admission,
                                  Runnable onUnstarted,
                                  Runnable body) {
}
