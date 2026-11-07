package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 统一的执行启动入口：根会话与子代理共用同一套「准入 → 提交 → 没能起步的收口」。
 *
 * <p><b>为什么要有这一个入口</b>：两条启动链原来各写一份 try/catch，结果只有根补了
 * 「提交被拒 → 收执行终态 + 释放运行资格」，子代理那份由异步体内的 catch 兜 —— 提交被拒时
 * 异步体根本不会执行，子登记就留成了孤儿。模板只写一遍，「哪条链漏了哪一步」这类问题才不再复发。</p>
 *
 * <p><b>为什么仍然分角色</b>：准入判据、线程池归属、撤销的是哪份登记，三者都不同（见
 * {@link ExecutionLaunchSpec}）。本类只做分派，不猜角色语义 —— 判据都在 {@link StartupFailureCloser}
 * 与各调用方给出的动作里。</p>
 *
 * <p><b>不重复收口</b>：{@link StartupFailureCloser} 按状态判据跳过已终态的执行，所以
 * 「提交被拒后再由异步体 catch 收一次」不会产生第二次可见副作用。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ExecutionLaunchGateway {

    /** 启动失败收口口径的唯一实现：角色到口径的映射只有那里一份。 */
    private final StartupFailureCloser startupFailureCloser;

    /**
     * 提交一次启动。
     *
     * <p>线程池拒绝提交时立刻按角色收口并原样抛出：拒绝意味着异步体永远不会执行，
     * 它的 finally / catch 都不会补收口，只能在这里补。</p>
     *
     * @param spec 启动请求
     */
    public void submit(ExecutionLaunchSpec spec) {
        throwIfInvalid(spec);
        try {
            spec.executor().submit(() -> start(spec));
        } catch (RuntimeException rejected) {
            releaseUnstarted(spec, rejected);
            throw rejected;
        }
    }

    /**
     * 没能起步的统一收口：按角色收执行终态，再撤销登记。
     *
     * <p>两步各自隔离 —— 收口失败不能连带丢掉登记撤销（那会让会话被单飞永久锁死），
     * 登记撤销失败也不能掩盖原始的「线程池拒绝」。</p>
     *
     * @param spec  启动请求
     * @param cause 没能起步的原因
     * @return 是否真的写过终态
     */
    public boolean releaseUnstarted(ExecutionLaunchSpec spec, RuntimeException cause) {
        throwIfInvalid(spec);
        boolean closed = false;
        Execution execution = spec.execution();
        if (execution != null) {
            closed = startupFailureCloser.closeQuietly(execution, cause, spec.role());
        }
        try {
            spec.onUnstarted().run();
        } catch (RuntimeException releaseFailure) {
            log.warn("撤销启动登记失败: role={}, executionId={}, 原因={}",
                    spec.role(), execution == null ? null : execution.getId(), releaseFailure.toString());
        }
        return closed;
    }

    /**
     * 角色线程池体：先过准入，再开跑。
     *
     * <p>准入被拒等于「这一份启动不该发生」（根已取消 / 单飞已被占）：撤销登记后直接返回，
     * 绝不建行、不开跑 —— 否则会留下没人收尾的孤儿行。</p>
     */
    private void start(ExecutionLaunchSpec spec) {
        if (!spec.admission().getAsBoolean()) {
            releaseUnstarted(spec, new IllegalStateException("启动准入被拒: role=" + spec.role()));
            return;
        }
        spec.body().run();
    }

    /** 入口校验统一走私有 throwIf，避免各调用方各写一份判据。 */
    private static void throwIfInvalid(ExecutionLaunchSpec spec) {
        if (spec == null) {
            throw new IllegalArgumentException("启动请求不能为空");
        }
        if (spec.role() == null) {
            throw new IllegalArgumentException("启动角色不能为空");
        }
        if (spec.executor() == null) {
            throw new IllegalArgumentException("启动线程池不能为空: role=" + spec.role());
        }
        if (spec.admission() == null) {
            throw new IllegalArgumentException("启动准入判据不能为空: role=" + spec.role());
        }
        if (spec.onUnstarted() == null) {
            throw new IllegalArgumentException("未能起步时的撤销动作不能为空: role=" + spec.role());
        }
        if (spec.body() == null) {
            throw new IllegalArgumentException("启动体不能为空: role=" + spec.role());
        }
    }
}
