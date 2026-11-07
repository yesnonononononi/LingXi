package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;

import java.util.function.Supplier;

/**
 * 一次新执行的启动描述：跑什么、跑谁的、失败按哪个口径收口。
 *
 * <p>body 由调用方给，是因为根会话跑的是编排器、子代理跑的是 {@code SubAgent} ——
 * 生命周期编排只管「失败怎么收」，不管「loop 怎么跑」。</p>
 */
public final class ExecutionLaunchSpec {

    private final Execution execution;
    private final ExecutionLaunchRole role;
    private final Supplier<Execution> body;

    private ExecutionLaunchSpec(Execution execution, ExecutionLaunchRole role, Supplier<Execution> body) {
        if (execution == null) {
            throw new IllegalArgumentException("启动执行必须提供执行对象");
        }
        if (role == null) {
            throw new IllegalArgumentException("启动执行必须提供收口口径");
        }
        if (body == null) {
            throw new IllegalArgumentException("启动执行必须提供执行体");
        }
        this.execution = execution;
        this.role = role;
        this.body = body;
    }

    /** 构造一次启动描述。 */
    public static ExecutionLaunchSpec create(Execution execution, ExecutionLaunchRole role, Supplier<Execution> body) {
        return new ExecutionLaunchSpec(execution, role, body);
    }

    public Execution execution() {
        return execution;
    }

    public ExecutionLaunchRole role() {
        return role;
    }

    public Supplier<Execution> body() {
        return body;
    }
}
