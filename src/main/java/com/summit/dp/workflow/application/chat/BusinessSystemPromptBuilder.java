package com.summit.dp.workflow.application.chat;

import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.workflow.application.delegation.TeamPromptComposer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.Objects;

/** 业务提示词在请求创建前定稿，避免执行快照与实际模型请求使用不同内容。 */
@Component
public class BusinessSystemPromptBuilder {

    private final String globalPrompt;

    public BusinessSystemPromptBuilder(@Value("${lingxi.system-prompt:}") String globalPrompt) {
        this.globalPrompt = globalPrompt == null ? "" : globalPrompt.trim();
    }

    /** 全局规则在前、人设在后；空段不产生分隔符。 */
    public String buildRootPrompt(String agentPrompt) {
        String rolePrompt = agentPrompt == null ? "" : agentPrompt.trim();
        if (globalPrompt.isEmpty()) return rolePrompt;
        if (rolePrompt.isEmpty()) return globalPrompt;
        return globalPrompt + "\n\n" + rolePrompt;
    }
    /** 子委派沿用成员职责与主理人上下文，不额外继承根执行的全局规则。 */
    public String buildMemberPrompt(AgentVO agent, TeamVO team, String callerPrompt) {
        String rolePrompt = TeamPromptComposer.memberPrompt(
                agent.getPrompt(),
                team == null ? null : team.getAgents(),
                agent.getId(),
                team == null ? null : team.getCommanderAgentId(),
                team == null ? null : team.getDescription()
        );
        return String.format("""
                %s

                # Commander 提供的任务上下文
                %s
                """, rolePrompt, Objects.toString(callerPrompt, "").trim());
    }
}
