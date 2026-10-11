package com.summit.dp.workflow.application.chat;

import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.domain.model.ReplyStyle;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.workflow.application.delegation.TeamPromptComposer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Objects;
import java.util.stream.Stream;

/** 业务提示词在请求创建前定稿，避免执行快照与实际模型请求使用不同内容。 */
@Component
public class BusinessSystemPromptBuilder {

    private final String globalPrompt;

    public BusinessSystemPromptBuilder(@Value("${lingxi.system-prompt:}") String globalPrompt) {
        this.globalPrompt = globalPrompt == null ? "" : globalPrompt.trim();
    }

    /** 空段不产生分隔符，未配置偏好时保持原有提示词。 */
    public String buildRootPrompt(String agentPrompt) {
        return buildRootPrompt(agentPrompt, null);
    }

    /** 偏好置于默认规则与团队职责之间，最终内容随本次请求定稿。 */
    public String buildRootPrompt(String agentPrompt, PersonalizationVO personalization) {
        return String.join("\n\n", Stream.of(globalPrompt, customPrompt(personalization),
                Objects.toString(agentPrompt, "").trim()).filter(section -> !section.isEmpty()).toList());
    }

    public String customPrompt(PersonalizationVO personalization) {
        if (personalization == null) return "";
        List<String> sections = new ArrayList<>();

        String name = Objects.toString(personalization.getCommonAgentName(), "").trim();
        if (!name.isEmpty()) sections.add("## 助手名字\n与用户交流时，使用用户指定的助手名字：\n" + name);

        String title = Objects.toString(personalization.getTitle(), "").trim();
        if (!title.isEmpty()) sections.add("## 用户称呼\n称呼用户时，使用以下称呼：\n" + title);

        String styleName = personalization.getReplyStyle();
        if (styleName != null && !styleName.isBlank()) {
            ReplyStyle style = Arrays.stream(ReplyStyle.values()).filter(candidate -> candidate.name().equals(styleName))
                    .findFirst().orElseThrow(() -> new ClientException("个性化配置中的回复风格不在支持列表中"));

            if (!style.getContent().isBlank()) sections.add("## 回复风格\n" + style.getContent());
        }

        String instruction = Objects.toString(personalization.getCustomInstruction(), "").trim();
        if (!instruction.isEmpty()) sections.add("## 用户偏好与自定义指令\n" + instruction);

        return sections.isEmpty() ? "" : "# 用户个性化偏好\n\n" + String.join("\n\n", sections);
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
