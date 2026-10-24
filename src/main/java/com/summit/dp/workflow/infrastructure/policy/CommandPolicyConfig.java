package com.summit.dp.workflow.infrastructure.policy;

import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecutionPolicy;
import com.summit.dp.workflow.application.approval.CommandApprovalRegistrar;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandGuard;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandShell;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
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
@Configuration(proxyBeanMethods = false)
public class CommandPolicyConfig {

    /** 本业务的挂起话题：框架不知道它的含义，前端按它渲染审批卡片。 */
    public static final String APPROVAL_TOPIC = "command.approval";

    public ToolExecutionPolicy commandApprovalPolicy(ObjectMapper mapper, CommandApprovalRegistrar approvalRegistrar) {
        return commandApprovalPolicy(mapper, approvalRegistrar, null);
    }
    @Bean
    public ToolExecutionPolicy commandApprovalPolicy(ObjectMapper mapper,
                                                     CommandApprovalRegistrar approvalRegistrar,
                                                     TerminalSecurityPolicy security) {
        return execution -> {
            if (execution.getToolDefinition() == null
                    || !(execution.getToolDefinition().executor() instanceof CommandToolDefinitionExecutor)) {
                return null;
            }


            ExecuteCommandRequest request;
            try {
                request = mapper.readValue(execution.getArgs(), ExecuteCommandRequest.class);
            } catch (Exception e) {
                return null;
            }
            String command = request.getCommand();
            if (command == null || command.isBlank()) {
                return null;
            }


            ShellType shell;
            try {
                // 审批卡记录的就是「批准后真正要用的」解释器，与执行侧同一处解析。
                shell = CommandShell.resolve(request, execution.getWorkspace());
            } catch (IllegalArgumentException unsupported) {
                return ToolExecuteResult.err(unsupported.getMessage());
            }
            CommandGuard.Verdict verdict = CommandGuard.assess(command, shell);

            // 毁灭性命令：内核会拒绝，这里直接给出结论，避免用户批准一条注定被拒的命令。
            if (verdict == CommandGuard.Verdict.DESTRUCTIVE) {
                return ToolExecuteResult.err("命令被拒绝：该命令具有破坏性（磁盘/系统级删除或不可逆操作），"
                        + "不允许审批放行，请改写命令或由用户自行执行。");
            }

            SecurityDecision decision = security == null ? null : security.evaluate(command);
            if (decision != null && decision.action() == SecurityAction.DENY) {
                return ToolExecuteResult.err("命令被安全规则禁止：" + decision.matchedRule());
            }
            boolean ask = decision == null ? requiresApproval(CommandApprovalPolicy.from(execution.getAttributes()), verdict)
                    : decision.action() == SecurityAction.ASK;
            if (!ask) {
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
