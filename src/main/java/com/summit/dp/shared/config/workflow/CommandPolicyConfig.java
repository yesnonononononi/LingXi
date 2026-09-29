package com.summit.dp.shared.config.workflow;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecutionPolicy;
import com.summit.dp.toolcall.application.service.CommandApprovalRegistrar;
import com.summit.dp.tools.baseTools.arguments.ExecuteCommandRequest;
import com.summit.dp.tools.baseTools.terminal.CommandGuard;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * 命令执行审批：档位与判定都在业务侧，登记动作交给 {@link CommandApprovalRegistrar}。
 *
 * <p>需审批的命令在 policy 内短路（不进入 {@code executeTool}），直接委派
 * {@link CommandApprovalRegistrar} 把这次调用登记为一条 {@code tool_call}
 * （{@code type=PROMISE}，{@code content.kind=COMMAND}）并返回 PROMISE。
 * 命令的实际执行发生在用户批准后的决策链路（{@code ToolCallService.decide}），
 * 此处只负责「落卡片 + 暂停」。</p>
 *
 * <p><b>职责边界（评审 P1-④）：</b>本类只做装配；「读命令 → 判定 → 登记 → 发事件」的业务编排
 * 由 {@link CommandApprovalRegistrar} 承担，可脱离 Spring 上下文测试。</p>
 */
@Configuration
public class CommandPolicyConfig {

    /** 本业务的挂起话题：框架不知道它的含义，前端按它渲染审批卡片。 */
    public static final String APPROVAL_TOPIC = "command.approval";

    @Bean
    public ToolExecutionPolicy commandApprovalPolicy(ObjectMapper mapper,
                                                     CommandApprovalRegistrar approvalRegistrar) {
        return execution -> {
            if (execution.getToolDefinition() == null
                    || !(execution.getToolDefinition().executor() instanceof CommandToolDefinitionExecutor)) {
                return null;
            }

            String command;
            try {
                command = mapper.readValue(execution.getArgs(), ExecuteCommandRequest.class).getCommand();
            } catch (Exception e) {
                return null;
            }
            if (command == null || command.isBlank()) {
                return null;
            }

            ShellType shell = execution.getWorkspace() == null ? null
                    : execution.getWorkspace().runtimeEnvironment().shellType();
            CommandGuard.Verdict verdict = CommandGuard.assess(command, shell);

            // 毁灭性命令：内核会拒绝，这里直接给出结论，避免用户批准一条注定被拒的命令。
            if (verdict == CommandGuard.Verdict.DESTRUCTIVE) {
                return ToolExecuteResult.err("命令被拒绝：该命令具有破坏性（磁盘/系统级删除或不可逆操作），"
                        + "不允许审批放行，请改写命令或由用户自行执行。");
            }

            if (!requiresApproval(CommandApprovalPolicy.from(execution.getAttributes()), verdict)) {
                return null;
            }

            if (execution.getWorkspace() == null || shell == null) {
                return ToolExecuteResult.err("命令执行环境不可用，无法发起审批");
            }
            approvalRegistrar.register(execution, command, shell);
            return ToolExecuteResult.promise("命令尚未执行，正在等待用户批准：" + command);
        };
    }

    private static boolean requiresApproval(CommandApprovalPolicy policy, CommandGuard.Verdict verdict) {
        return switch (policy) {
            case FULL_ACCESS -> false;
            case PRE_EXEC_CONFIRM -> true;
            case DANGEROUS_BLOCK -> verdict == CommandGuard.Verdict.REQUIRES_APPROVAL;
        };
    }
}
