package com.summit.dp.agent.infrastructure.workflow;

import com.summit.dp.agent.application.vo.AgentVO;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 协作提示词话术回归：指挥者与团队成员必须看到<b>同一份</b>团队成员名单渲染。
 *
 * <p>团队成员现在也有 {@code send_mail_to_agent}，发信要填 {@code toAgentId}——
 * 名单格式一旦两边分叉，成员就会猜 id 或写给不存在的角色。这里把「同一份话术」锁死。</p>
 */
class TeamPromptComposerTest {

    private static final String TEAM_DESCRIPTION = "后端研发协作团队";

    private static final List<AgentVO> TEAM = List.of(
            agent(5L, "产品经理", "负责需求拆解与验收"),
            agent(6L, "架构师", "负责系统设计"),
            agent(7L, "开发工程师", "负责编码实现"));

    @Test
    @DisplayName("同一份名单渲染：两边共用 roster，行格式完全一致，只剔除自身")
    void commanderAndMemberShareTheSameRosterWording() {
        String commanderRoster = TeamPromptComposer.roster(TEAM, 5L, "（空）");
        String memberRoster = TeamPromptComposer.roster(TEAM, 6L, "（空）");

        assertTrue(commanderRoster.contains("### 成员名单(TEAM ROSTER)"));
        assertTrue(commanderRoster.contains("- id: 6") && commanderRoster.contains("- name: 架构师")
                        && commanderRoster.contains("- description: 负责系统设计"),
                "指挥者名单：剔除自己，保留全部队友");
        assertFalse(commanderRoster.contains("- id: 5"), "指挥者自身不出现在名单里");

        assertTrue(memberRoster.contains("- id: 5") && memberRoster.contains("- id: 7"),
                "成员名单：保留指挥者与其他队友");
        assertFalse(memberRoster.contains("- id: 6"), "成员自身不出现在名单里");

        assertTrue(TeamPromptComposer.commanderPrompt("人设", TEAM, 5L, TEAM_DESCRIPTION)
                        .contains(commanderRoster),
                "指挥者提示词里嵌的就是这份渲染");
        assertTrue(TeamPromptComposer.memberPrompt("人设", TEAM, 6L, TEAM_DESCRIPTION)
                        .contains(memberRoster),
                "成员提示词里嵌的也是这份渲染");
    }

    @Test
    @DisplayName("职责段按角色区分：指挥者可委派，成员明确没有委派能力")
    void roleSectionsDifferByResponsibility() {
        String commander = TeamPromptComposer.commanderPrompt("人设", TEAM, 5L, TEAM_DESCRIPTION);
        assertTrue(commander.contains("### 主理人职责"), "指挥者职责段");
        assertTrue(commander.contains("你是团队的主理人"));
        assertTrue(commander.contains("call_sub_agent"), "指挥者有委派能力");
        assertTrue(commander.contains(TEAM_DESCRIPTION), "团队描述随提示词下发");
        assertFalse(commander.contains("### 成员职责"), "指挥者不叫「团队成员」");

        String member = TeamPromptComposer.memberPrompt("人设", TEAM, 6L, TEAM_DESCRIPTION);
        assertTrue(member.contains("### 成员职责"), "成员职责段");
        assertTrue(member.contains("你没有委派能力"), "明确成员不能转派任务");
        assertTrue(member.contains(TEAM_DESCRIPTION), "团队描述随提示词下发");
        assertFalse(member.contains("### 主理人职责"), "成员没有主理人职责这一说");
    }

    @Test
    @DisplayName("人设保留、名单为空时有占位文案、null 团队不炸")
    void handlesEdgeCases() {
        assertTrue(TeamPromptComposer.commanderPrompt("我是人设", TEAM, 5L, TEAM_DESCRIPTION)
                .startsWith("我是人设"));
        assertTrue(TeamPromptComposer.memberPrompt("我是人设", TEAM, 6L, TEAM_DESCRIPTION)
                .startsWith("我是人设"));

        assertTrue(TeamPromptComposer.commanderPrompt(null, List.of(), 5L, TEAM_DESCRIPTION)
                .contains("（无可委派队友；请自行完成任务）"));
        assertTrue(TeamPromptComposer.memberPrompt(null, null, 6L, TEAM_DESCRIPTION)
                .contains("（暂无其他团队成员）"));
    }

    @Test
    @DisplayName("名单成员缺名字/描述时用占位文案，不产生 null 字面量")
    void describesAgentWithPlaceholders() {
        AgentVO blank = new AgentVO();
        blank.setId(9L);

        String roster = TeamPromptComposer.roster(List.of(blank), 5L, "（空）");

        assertTrue(roster.contains("- id: 9"));
        assertTrue(roster.contains("未知成员"), "缺名字用占位文案");
        assertTrue(roster.contains("未提供能力描述"), "缺描述用占位文案");
        assertFalse(roster.contains("null"), "不产生 null 字面量");
    }

    private static AgentVO agent(Long id, String name, String description) {
        AgentVO agent = new AgentVO();
        agent.setId(id);
        agent.setName(name);
        agent.setDescription(description);
        return agent;
    }
}
