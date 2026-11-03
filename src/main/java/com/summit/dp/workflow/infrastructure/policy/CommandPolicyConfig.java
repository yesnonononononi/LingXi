package com.summit.dp.workflow.infrastructure.policy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecutionPolicy;
import com.summit.dp.sandbox_security.application.CommandRiskClassifier;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.workflow.application.approval.CommandApprovalRegistrar;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandShell;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 审批由业务侧统一裁决，登记后暂停执行，批准后才进入命令执行器。 */
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
            CommandApprovalPolicy mode = CommandApprovalPolicy.from(execution.getAttributes());
            CommandRiskClassifier.Risk risk = CommandRiskClassifier.assess(command);
            SecurityDecision decision = security == null ? null : security.evaluate(command, mode);
            if (decision != null && decision.action() == SecurityAction.DENY) {
                return ToolExecuteResult.err(decision.describe());
            }
            // 高危审批不能被允许规则跳过，完全放行也只在这一层保留询问。
            boolean ask = risk == CommandRiskClassifier.Risk.CRITICAL
                    || (mode != CommandApprovalPolicy.FULL_ACCESS
                    && (decision == null ? requiresApproval(mode, risk) : decision.action() == SecurityAction.ASK));
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

    private static boolean requiresApproval(CommandApprovalPolicy policy, CommandRiskClassifier.Risk risk) {
        return switch (policy) {
            case FULL_ACCESS -> false;
            case PRE_EXEC_CONFIRM -> true;
            case DANGEROUS_BLOCK -> risk == CommandRiskClassifier.Risk.ELEVATED;
        };
    }
}
