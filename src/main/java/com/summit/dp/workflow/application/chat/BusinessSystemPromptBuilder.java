package com.summit.dp.workflow.application.chat;

import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.personalization.application.vo.PersonalizationVO;
import com.summit.dp.personalization.domain.model.ReplyStyle;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.team.application.vo.TeamVO;
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
    private final ProductDocsPrompt productDocsPrompt;

    public BusinessSystemPromptBuilder(String globalPrompt) {
        this(globalPrompt, workspace -> "", new RenderSyntaxPrompt(), new ProductDocsPrompt());
    }

    /** 记忆段可替换、渲染语法与产品文档取产品默认实现：委派链路只关心成员提示词，不需要装配这些段。 */
    public BusinessSystemPromptBuilder(String globalPrompt, ProjectMemoryPrompt projectMemoryPrompt) {
        this(globalPrompt, projectMemoryPrompt, new RenderSyntaxPrompt(), new ProductDocsPrompt());
    }

    @Autowired
    public BusinessSystemPromptBuilder(@Value("${lingxi.system-prompt:}") String globalPrompt,
                                       ProjectMemoryPrompt projectMemoryPrompt,
                                       RenderSyntaxPrompt renderSyntaxPrompt,
                                       ProductDocsPrompt productDocsPrompt) {
        this.globalPrompt = globalPrompt == null ? "" : globalPrompt.trim();
        this.projectMemoryPrompt = projectMemoryPrompt;
        this.renderSyntaxPrompt = renderSyntaxPrompt;
        this.productDocsPrompt = productDocsPrompt;
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
     * 根提示词：全局规则 → 产品渲染语法 → 产品文档 → 用户偏好 → 角色职责 → 项目记忆。
     *
     * <p>渲染语法与产品文档紧跟全局规则：它们都是「平台怎么用」的产品事实，排在用户偏好之前，
     * 用户改自己的偏好时不会碰掉产品能力说明。</p>
     */
    public String buildRootPrompt(String agentPrompt, PersonalizationVO personalization, WorkspaceSpec workspace) {
        return String.join("\n\n", Stream.of(globalPrompt, renderSyntaxPrompt.load(), productDocsPrompt.load(),
                        customPrompt(personalization), Objects.toString(agentPrompt, "").trim(),
                        projectMemoryPrompt.load(workspace))
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

    /** 子委派沿用成员职责，不额外继承根执行的全局规则。 */
    public String buildMemberPrompt(AgentVO agent, TeamVO team) {
        return buildMemberPrompt(agent, team, null);
    }

    /**
     * 成员提示词：职责与名单 → 项目记忆，全部是跨委派恒定的内容。
     *
     * <p>刻意不带渲染语法段与委派上下文：前者是给用户的正文契约；后者每次委派都不同，而复用
     * 子会话时框架原样保留历史里那条旧系统消息、丢弃新生成的，放进来只会让本次约束整段丢失。</p>
     */
    public String buildMemberPrompt(AgentVO agent, TeamVO team, WorkspaceSpec workspace) {
        String rolePrompt = TeamPromptComposer.memberPrompt(
                agent.getPrompt(),
                team == null ? null : team.getAgents(),
                agent.getId(),
                team == null ? null : team.getCommanderAgentId(),
                team == null ? null : team.getDescription()
        );
        String memoryPrompt = projectMemoryPrompt.load(workspace);
        return memoryPrompt.isEmpty() ? rolePrompt : rolePrompt + "\n" + memoryPrompt;
    }
}
