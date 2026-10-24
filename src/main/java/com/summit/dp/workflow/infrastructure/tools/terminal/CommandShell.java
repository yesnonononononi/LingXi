package com.summit.dp.workflow.infrastructure.tools.terminal;

import com.summit.core.runtime.workspace.OsType;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;

/**
 * 一次命令调用实际使用的解释器解析点。
 *
 * <p>「用哪个 shell 执行」只能有一处结论：参数校验、安全检查、审批快照、审批恢复和真正启动都
 * 从这里取值，避免各处各自推断后出现「按 cmd 判危险、按 pwsh 执行」这类不一致。请求未指定时
 * 取工作空间默认；指定了但当前平台不支持时直接失败，不静默改用别的解释器。</p>
 */
public final class CommandShell {

    private CommandShell() {
    }

    /**
     * 返回本次调用实际使用的解释器。
     *
     * @param request   模型下发的参数（可为 {@code null}）
     * @param workspace 目标工作空间（可为 {@code null}，此时只认请求里显式指定的 shell）
     * @throws IllegalArgumentException 请求的 shell 未知或不属于当前平台
     */
    public static ShellType resolve(ExecuteCommandRequest request, Workspace workspace) {
        RuntimeEnvironment environment = workspace == null ? null : workspace.runtimeEnvironment();
        OsType os = environment == null ? null : environment.osType();
        ShellType requested = ShellType.select(request == null ? null : request.getShell(), os);
        if (requested != null) {
            return requested;
        }
        return environment == null ? null : environment.shellType();
    }
}
