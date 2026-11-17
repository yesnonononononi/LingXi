package com.summit.dp.workflow.application.decision;

import com.summit.core.agent.Execution;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.workspace.BasicWorkspaceSpec;
import com.summit.core.workspace.WorkspaceOptions;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.runtime.workspace.LocalWorkspaceProvider;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 审批恢复时解析「这次调用要落地的宿主环境」。
 *
 * <p>各形态共用同一份回落：审批只是把同一次调用重新放行，不能比首次执行更严格，
 * 否则有的卡片批了也跑不起来。</p>
 */
@Component
@RequiredArgsConstructor
public class ApprovalWorkspaceResolver {

    private final WorkspaceResolver workspaces;

    /**
     * 解析执行所属工作空间。
     *
     * <p>会话未绑定工作空间时请求里没有规格（框架允许缺省，工具就跑在进程工作目录）。
     * 回落规格必须与框架同形：{@link BasicWorkspaceSpec} 的 scope 为空，派生的工作空间 id
     * 才与签发审批卡时一致；换成带 scope 的实现会被各形态的环境校验误判成「环境已变化」。</p>
     */
    public Workspace resolve(Execution execution) {
        return resolve(execution, execution.getAgentRequest().getWorkspaceOptions());
    }

    /** 按指定的工作区访问选项解析工作空间（例如审批放行后临时抬升沙箱访问档位）。 */
    public Workspace resolve(Execution execution, WorkspaceOptions options) {
        WorkspaceSpec spec = execution.getAgentRequest().getWorkspaceSpec();
        if (spec == null) {
            spec = new BasicWorkspaceSpec(LocalWorkspaceProvider.TYPE, System.getProperty("user.dir"));
        }
        return options == null ? workspaces.resolve(spec) : workspaces.resolve(spec, options);
    }
}
