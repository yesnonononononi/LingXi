package com.summit.dp.workflow.infrastructure.policy;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecutionPolicy;
import com.summit.dp.sandbox_security.application.CommandRiskClassifier;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.application.decision.CommandApprovalRegistrar;
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
            AgentPermissionMode mode = AgentPermissionMode.from(execution.getAttributes());
            if (!mode.allowsTerminalTools()) {
                return ToolExecuteResult.err("只读审阅模式下禁止执行终端命令");
            }
            SecurityDecision decision = security == null ? null : security.evaluate(command, mode);
            if (decision != null && decision.action() == SecurityAction.DENY) {
                return ToolExecuteResult.err(decision.describe());
            }
            // 完全放行是明确的免审批选择，不能再由命令文本的风险判定覆盖。
            if (mode.bypassesCommandApproval()) {
                return null;
            }
            CommandRiskClassifier.Risk risk = CommandRiskClassifier.assess(command);
            // 其余档位的高危审批不能被允许规则跳过。
            boolean ask = risk == CommandRiskClassifier.Risk.CRITICAL
                    || (decision == null ? requiresApproval(mode, risk) : decision.action() == SecurityAction.ASK);
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

    private static boolean requiresApproval(AgentPermissionMode mode, CommandRiskClassifier.Risk risk) {
        if (mode.bypassesCommandApproval()) {
            return false;
        }
        if (mode.requiresPerCommandApproval()) {
            return true;
        }
        return mode.requiresDangerousCommandApproval() && risk == CommandRiskClassifier.Risk.ELEVATED;
    }
}
