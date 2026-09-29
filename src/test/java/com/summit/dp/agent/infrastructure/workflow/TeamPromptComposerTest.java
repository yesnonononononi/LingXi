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

    private static final List<AgentVO> TEAM = List.of(
            agent(5L, "产品经理", "负责需求拆解与验收"),
            agent(6L, "架构师", "负责系统设计"),
            agent(7L, "开发工程师", "负责编码实现"));

    @Test
    @DisplayName("同一份名单渲染：两边共用 roster，行格式完全一致，只剔除自身")
    void commanderAndMemberShareTheSameRosterWording() {
        String commanderRoster = TeamPromptComposer.roster(TEAM, 5L, "（空）");
        String memberRoster = TeamPromptComposer.roster(TEAM, 6L, "（空）");

        assertEquals("""
                - id: 6 | name: 架构师 | description: 负责系统设计
                - id: 7 | name: 开发工程师 | description: 负责编码实现""", commanderRoster,
                "指挥者名单：剔除自己，保留全部队友");
        assertEquals("""
                - id: 5 | name: 产品经理 | description: 负责需求拆解与验收
                - id: 7 | name: 开发工程师 | description: 负责编码实现""", memberRoster,
                "成员名单：剔除自己，保留指挥者与其他队友");

        assertTrue(TeamPromptComposer.commanderPrompt("人设", TEAM, 5L).contains(commanderRoster),
                "指挥者提示词里嵌的就是这份渲染");
        assertTrue(TeamPromptComposer.memberPrompt("人设", TEAM, 6L).contains(memberRoster),
                "成员提示词里嵌的也是这份渲染");
    }

    @Test
    @DisplayName("职责段按角色区分：指挥者可委派，成员明确没有委派能力且知道用邮件同步")
    void roleSectionsDifferByResponsibility() {
        String commander = TeamPromptComposer.commanderPrompt("人设", TEAM, 5L);
        assertTrue(commander.contains("# 可委派队友"));
        assertTrue(commander.contains("你是团队的 Commander"));
        assertFalse(commander.contains("# 团队成员"), "指挥者不叫「团队成员」");

        String member = TeamPromptComposer.memberPrompt("人设", TEAM, 6L);
        assertTrue(member.contains("# 团队成员"));
        assertTrue(member.contains("你是本次多 Agent 协作的团队成员"));
        assertTrue(member.contains("send_mail_to_agent"), "告诉成员同步信息的手段");
        assertTrue(member.contains("你没有委派能力"), "明确成员不能转派任务");
        assertFalse(member.contains("# 可委派队友"), "成员没有可委派队友这一说");
    }

    @Test
    @DisplayName("人设保留、名单为空时有占位文案、null 团队不炸")
    void handlesEdgeCases() {
        assertTrue(TeamPromptComposer.commanderPrompt("我是人设", TEAM, 5L).startsWith("我是人设"));
        assertTrue(TeamPromptComposer.memberPrompt("我是人设", TEAM, 6L).startsWith("我是人设"));

        assertTrue(TeamPromptComposer.commanderPrompt(null, List.of(), 5L).contains("（无可委派队友；请自行完成任务）"));
        assertTrue(TeamPromptComposer.memberPrompt(null, null, 6L).contains("（暂无其他团队成员）"));

        assertFalse(TeamPromptComposer.commanderPrompt("  ", null, 5L).startsWith("  "), "人设两侧空白应被裁掉");
    }

    @Test
    @DisplayName("名单成员缺名字/描述时用占位文案，不产生 null 字面量")
    void describesAgentWithPlaceholders() {
        AgentVO blank = new AgentVO();
        blank.setId(9L);

        String roster = TeamPromptComposer.roster(List.of(blank), 5L, "（空）");

        assertEquals("- id: 9 | name: 未命名 | description: 未提供能力描述", roster);
    }

    private static AgentVO agent(Long id, String name, String description) {
        AgentVO agent = new AgentVO();
        agent.setId(id);
        agent.setName(name);
        agent.setDescription(description);
        return agent;
    }
}
