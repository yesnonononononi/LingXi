package com.summit.dp.tools.application.service;

import com.summit.dp.tools.application.port.ToolCatalog;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/** 所有补充规则先执行，权限限制最后执行，避免后补工具绕过只读与身份约束。 */
@Component
@RequiredArgsConstructor
public class ToolListProcessor {
    private final ToolCatalog toolCatalog;

    public List<String> process(List<String> configured, ToolProcessingContext context) {
        Set<String> tools = new LinkedHashSet<>();
        if (context.defaultAgent()) tools.addAll(ToolCatalog.DEFAULT_AGENT_TOOLS);
        if (configured != null) {
            configured.stream().filter(name -> name != null && !name.isBlank()).map(String::trim).forEach(tools::add);
        }
        // 写回执不再携带整份清单，已有清单写权限的 Agent 必须能按需读取权威步骤标识。
        if (tools.contains(ToolCatalog.CREATE_CHECKLIST) || tools.contains(ToolCatalog.UPDATE_CHECKLIST_STEP)
                || tools.contains(ToolCatalog.MODIFY_CHECKLIST) || tools.contains(ToolCatalog.DELETE_CHECKLIST)) {
            tools.add(ToolCatalog.GET_CURRENT_CHECKLIST);
        }
        if (context.member()) {
            tools.add(ToolCatalog.SEND_MAIL_TO_AGENT);
        } else if (context.teamId() != null && context.agentId() != null) {
            tools.add(ToolCatalog.CALL_SUB_AGENT);
            // 指挥者专属、固定下发：不依赖 Agent 配置里写没写它。
            tools.add(ToolCatalog.PEEK_TEAMMATE_STATE);
            tools.add(ToolCatalog.SEND_MAIL_TO_AGENT);
        }
        if (context.mcpConfig() != null && context.mcpConfig().getMcp() != null && !context.mcpConfig().getMcp().isEmpty()) {
            tools.add(ToolCatalog.LIST_MCP_TOOLS);
            tools.add(ToolCatalog.SEARCH_TOOL);
        }
        if (context.skillRoot() != null) tools.add(ToolCatalog.READ_SKILL);
        if (context.requirePlan()) tools.add(ToolCatalog.CREATE_PLAN);
        if (context.vision()) tools.add(ToolCatalog.READ_IMAGE);
        else tools.remove(ToolCatalog.READ_IMAGE);

        if (!context.accessMode().allowsWriteTools()) {
            Set<String> readOnly = toolCatalog.readOnlyNames();
            tools.removeIf(name -> !ToolCatalog.EXECUTE_COMMAND.equals(name) && !ToolCatalog.MANAGE_COMMAND.equals(name)
                    && !readOnly.contains(name));
        }
        if (context.member() || context.teamId() == null) {
            tools.remove(ToolCatalog.CALL_SUB_AGENT);
            tools.remove(ToolCatalog.PEEK_TEAMMATE_STATE);
        }
        if (!context.member() && context.agentId() == null) tools.remove(ToolCatalog.SEND_MAIL_TO_AGENT);
        return List.copyOf(tools);
    }
}
