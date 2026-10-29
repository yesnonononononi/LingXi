package com.summit.dp.agent.infrastructure.workflow;

import com.summit.dp.workflow.application.delegation.TeamPromptComposer;

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
        assertTrue(TeamPromptComposer.memberPrompt("人设", TEAM, 6L, 5L, TEAM_DESCRIPTION)
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

        String member = TeamPromptComposer.memberPrompt("人设", TEAM, 6L, 5L, TEAM_DESCRIPTION);
        assertTrue(member.contains("### 成员职责"), "成员职责段");
        assertTrue(member.contains("你没有委派能力"), "明确成员不能转派任务");
        assertTrue(member.contains(TEAM_DESCRIPTION), "团队描述随提示词下发");
        assertFalse(member.contains("### 主理人职责"), "成员没有主理人职责这一说");
    }

    @Test
    @DisplayName("成员提示词显式带出主理人 agentId：成员发信填 toAgentId，不必猜 id")
    void memberPromptCarriesCommanderAgentId() {
        String member = TeamPromptComposer.memberPrompt("人设", TEAM, 6L, 5L, TEAM_DESCRIPTION);
        assertTrue(member.contains("send_mail_to_agent"), "成员可通过邮件补充通知");
        assertTrue(member.contains("主理人的 agentId 是 5"),
                "必须显式写出主理人 agentId，否则成员只能猜（send_mail_to_agent 的 toAgentId 是必填入参）");

        String memberWithoutCommander = TeamPromptComposer.memberPrompt("人设", TEAM, 6L, null, TEAM_DESCRIPTION);
        assertTrue(memberWithoutCommander.contains("主理人的 agentId 是 未提供"), "缺主理人 id 时用占位文案，不产生 null 字面量");
    }

    @Test
    @DisplayName("主理人按阻塞返回值与协作产物收口，内部交付故障自行处理")
    void commanderOwnsDeliveryWithoutMemberMail() {
        String prompt = TeamPromptComposer.commanderPrompt("人设", TEAM, 5L, TEAM_DESCRIPTION);

        assertTrue(prompt.contains("委派为协作式") && prompt.contains("受理后你继续推进其它主线步骤"));
        assertTrue(prompt.contains("交付说明与邮件都不是验收依据")
                && prompt.contains("核验成员工作目录中的实际产物与验证记录"));
        assertTrue(prompt.contains("改动文件清单、自检结论（实际执行的命令与结果）、未决项"));
        assertTrue(prompt.contains("先自行读文件、跑验证"));
        assertTrue(prompt.contains("由你补做或重新委派"));
        assertTrue(prompt.contains("回退能让回归用例变红"));
        assertFalse(prompt.contains("等待用户决策是否重新委派"));
    }

    @Test
    @DisplayName("主理人的唤醒手段唯一锁定 call_sub_agent，禁止把邮件当唤醒/催办通道")
    void commanderWakesTeammatesOnlyThroughDelegation() {
        String prompt = TeamPromptComposer.commanderPrompt("人设", TEAM, 5L, TEAM_DESCRIPTION);

        assertTrue(prompt.contains("启动新任务或重新启动已结束的队员只用 `call_sub_agent`"),
                "唤醒手段必须唯一锁定在 call_sub_agent");
        assertTrue(prompt.contains("不要用 `send_mail_to_agent` 启动任务或反复催办"),
                "必须显式禁止把邮件当唤醒通道");
        assertTrue(prompt.contains("直到它再次执行才可能读取"),
                "明确结束后的队员不会被邮件启动，再次运行才会读信");
        assertFalse(TeamPromptComposer.memberPrompt("人设", TEAM, 6L, 5L, TEAM_DESCRIPTION)
                        .contains("启动新任务或重新启动已结束的队员只用"),
                "这条约束属于主理人职责，不得串到成员提示词里");
    }

    @Test
    @DisplayName("成员以落盘产物和验证记录交付，邮件仅补充通知")
    void memberDeliversArtifactsAndExplicitValidation() {
        String prompt = TeamPromptComposer.memberPrompt("人设", TEAM, 6L, 5L, TEAM_DESCRIPTION);

        assertTrue(prompt.contains("改动文件清单、自检结论（实际执行的命令与结果）、未决项"));
        assertTrue(prompt.contains("主理人会核验产物"));
        assertTrue(prompt.contains("把产物和验证记录写入工作目录"));
        assertTrue(prompt.contains("交付通知只是补充"));
        assertTrue(prompt.contains("未运行的检查必须如实说明"));
    }

    @Test
    @DisplayName("队员直接协调共享文件，无需通知主理人；主理人可向运行中的队员补充信息")
    void teamMailSupportsDirectCoordinationAndSupplementaryInformation() {
        String member = TeamPromptComposer.memberPrompt("人设", TEAM, 6L, 5L, TEAM_DESCRIPTION);
        assertTrue(member.contains("同一文件") && member.contains("同一工作区"));
        assertTrue(member.contains("直接协商，无需通知主理人"));
        assertTrue(member.contains("文件路径、准备修改的范围、执行顺序和交接条件"));
        assertTrue(member.contains("队员互发邮件不会通知或唤醒主理人"));
        assertTrue(member.contains("未收到回复不等于同意"));
        assertTrue(member.contains("只有协商无法解决的冲突、任务范围变更或需要主理人决策的阻塞"));
        assertTrue(member.contains("主理人也可以发邮件补充需求、约束或新发现"));

        String commander = TeamPromptComposer.commanderPrompt("人设", TEAM, 5L, TEAM_DESCRIPTION);
        assertTrue(commander.contains("向正在执行任务的队员补充需求、约束、接口约定或新发现"));
        assertTrue(commander.contains("日常协调无需通知你"));
        assertTrue(commander.contains("补充信息用邮件，不要重复委派"));
    }

    @Test
    @DisplayName("人设保留、名单为空时有占位文案、null 团队不炸")
    void handlesEdgeCases() {
        assertTrue(TeamPromptComposer.commanderPrompt("我是人设", TEAM, 5L, TEAM_DESCRIPTION)
                .startsWith("我是人设"));
        assertTrue(TeamPromptComposer.memberPrompt("我是人设", TEAM, 6L, 5L, TEAM_DESCRIPTION)
                .startsWith("我是人设"));

        assertTrue(TeamPromptComposer.commanderPrompt(null, List.of(), 5L, TEAM_DESCRIPTION)
                .contains("（无可委派队友；请自行完成任务）"));
        assertTrue(TeamPromptComposer.memberPrompt(null, null, 6L, 5L, TEAM_DESCRIPTION)
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
