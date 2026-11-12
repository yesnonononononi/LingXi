package com.summit.dp.workflow.application.chat;

import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.domain.model.ReplyStyle;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.core.workspace.WorkspaceSpec;
import org.springframework.beans.factory.annotation.Autowired;
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
    private final ProjectMemoryPrompt projectMemoryPrompt;
    private final RenderSyntaxPrompt renderSyntaxPrompt;

    public BusinessSystemPromptBuilder(String globalPrompt) {
        this(globalPrompt, workspace -> "", new RenderSyntaxPrompt());
    }

    /** 记忆段可替换、渲染语法取产品默认实现：委派链路只关心成员提示词，不需要装配渲染语法。 */
    public BusinessSystemPromptBuilder(String globalPrompt, ProjectMemoryPrompt projectMemoryPrompt) {
        this(globalPrompt, projectMemoryPrompt, new RenderSyntaxPrompt());
    }

    @Autowired
    public BusinessSystemPromptBuilder(@Value("${lingxi.system-prompt:}") String globalPrompt,
                                       ProjectMemoryPrompt projectMemoryPrompt,
                                       RenderSyntaxPrompt renderSyntaxPrompt) {
        this.globalPrompt = globalPrompt == null ? "" : globalPrompt.trim();
        this.projectMemoryPrompt = projectMemoryPrompt;
        this.renderSyntaxPrompt = renderSyntaxPrompt;
    }

    /** 空段不产生分隔符，未配置偏好时保持原有提示词。 */
    public String buildRootPrompt(String agentPrompt) {
        return buildRootPrompt(agentPrompt, null);
    }

    /** 偏好置于默认规则与团队职责之间，最终内容随本次请求定稿。 */
    public String buildRootPrompt(String agentPrompt, PersonalizationVO personalization) {
        return buildRootPrompt(agentPrompt, personalization, null);
    }

    /**
     * 根提示词：全局规则 → 产品渲染语法 → 用户偏好 → 角色职责 → 项目记忆。
     *
     * <p>渲染语法紧跟全局规则：两者都是「平台怎么用」的规则，排在用户偏好之前，
     * 用户改自己的偏好时不会碰掉产品能力说明。</p>
     */
    public String buildRootPrompt(String agentPrompt, PersonalizationVO personalization, WorkspaceSpec workspace) {
        return String.join("\n\n", Stream.of(globalPrompt, renderSyntaxPrompt.load(), customPrompt(personalization),
                Objects.toString(agentPrompt, "").trim(), projectMemoryPrompt.load(workspace))
                .filter(section -> !section.isEmpty()).toList());
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
        return buildMemberPrompt(agent, team, callerPrompt, null);
    }

    /**
     * 成员提示词：职责与名单 → 委派上下文 → 项目记忆。
     *
     * <p>刻意不带渲染语法段：成员产出是给主理人的报告，不是直接呈现给用户的正文，
     * 把产品的渲染契约塞进去只会挤占成员自己的上下文。</p>
     */
    public String buildMemberPrompt(AgentVO agent, TeamVO team, String callerPrompt, WorkspaceSpec workspace) {
        String rolePrompt = TeamPromptComposer.memberPrompt(
                agent.getPrompt(),
                team == null ? null : team.getAgents(),
                agent.getId(),
                team == null ? null : team.getCommanderAgentId(),
                team == null ? null : team.getDescription()
        );
        String prompt = String.format("""
                %s

                # Commander 提供的任务上下文
                %s
                """, rolePrompt, Objects.toString(callerPrompt, "").trim());
        String memoryPrompt = projectMemoryPrompt.load(workspace);
        return memoryPrompt.isEmpty() ? prompt : prompt + "\n" + memoryPrompt;
    }
}
