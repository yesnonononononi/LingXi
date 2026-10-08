package com.summit.dp.agent.infrastructure.workflow;

import com.summit.dp.agent.application.vo.AgentVO;

import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;

/**
 * 多 Agent 协作的角色提示词合成：指挥者与团队成员共用同一份「团队成员名单」话术。
 *
 * <p>为什么要共用：团队成员现在也有 {@code TEAM_ID} 与 {@code send_mail_to_agent}，
 * 发信要填 {@code toAgentId}——名单必须和指挥者看到的是<b>同一份渲染</b>（同一个
 * {@code - id: … | name: … | description: …} 格式、同样的空名单占位），否则成员会猜 id
 * 或写信给不存在的角色。</p>
 *
 * <p>两者的差别只在<b>职责段</b>：指挥者负责拆分与委派、汇总；成员只对自己的任务负责，
 * 没有委派能力，需要同步信息时用邮件。名单段两边完全一致。</p>
 */
public final class TeamPromptComposer {



    private TeamPromptComposer() {
    }

    /**
     * 指挥者提示词：人设 + 协作职责 + 可委派队友名单。
     *
     * @param defaultPrompt    Agent 自身人设
     * @param team             团队全部成员（可为 null）
     * @param commanderAgentId 指挥者自身 id，从名单中剔除
     */
    public static String commanderPrompt(String defaultPrompt, List<AgentVO> team, Long commanderAgentId,String teamDescription) {
        String roster = roster(team, commanderAgentId, "（无可委派队友；请自行完成任务）");
        return String.format("""
                %s
                #### **团队协作模式(TEAM COORDINATION MODE)**
                ### 团队描述(TEAM DESCRIPTION)
                %s
                ### 主理人职责
                # 身份 :
                 - 你是团队的主理人,负责精准分析用户需求,对付较为复杂的开发工作,需要分配任务给团队成员,可以同时分配,也可以串行分配等待结果后再分配
                # 协作能力 :
                 - 你拥有委派能力（TOOL: `call_sub_agent`），可以分配任务给成员
                 - 协作工具类如 `mail`,可以发送邮件给成员,成员并不一定会回复,比如它们工作已经完成
                # 注意项 :
                 - 不要调用自己，不要为同一任务重复委派，也不要调用下列名单之外的 Agent。
                 - 成员执行失败时,需要反馈给用户,等待用户决策是否重新委派还是自己兜底执行
                 - 不要相信成员的执行结果，需要自己实际确认
                %s
                """, defaultPrompt, teamDescription, roster);
    }

    /**
     * 团队成员提示词：人设 + 协作职责（无委派能力）+ 团队成员名单。
     *
     * @param defaultPrompt Agent 自身人设
     * @param team          团队全部成员（可为 null）
     * @param memberAgentId 成员自身 id，从名单中剔除
     */
    public static String memberPrompt(String defaultPrompt, List<AgentVO> team, Long memberAgentId,String teamDescription) {
        String roster = roster(team, memberAgentId, "（暂无其他团队成员）");
        return String.format("""
                %s
                #### **团队协作模式(TEAM COORDINATION MODE)**
                ### 团队描述(TEAM DESCRIPTION)
                %s
                ### 成员职责
                # 身份 :
                 - 你是本次参与协作的团队成员，认真负责完成主理人交给你的任务,结果最为一个包含`本次完成的工作`,`执行成果`,`遗留问题`的交付文档
                # 协作能力 :
                 - 你可能会被允许查看其他成员的身份,在被授予可执行的团队通信工具的情况下,可以选择性的和其它成员进行沟通协作,注意,这并不意味着你一定会得到回信,所以最好在需要`异步通信`的场景下协作;
                 - 你也可能在执行过程中收到其它成员的消息,你可以选择性的回复,当然也可能会被忽视(它们的任务可能已经结束),可以稳妥交给主理人裁决
                # 注意项 :
                 - 你没有委派能力（没有 call_sub_agent），不要尝试把任务转派给其他 Agent；也不要调用下列名单之外的 Agent。
                 - 只需要将结果交付给主理人
                 - 不要越过职责范围执行其他成员的工作,保持上下文干净
                %s
                """,defaultPrompt,teamDescription, roster);
    }

    /**
     * 团队成员名单：指挥者与成员共用同一份渲染。
     *
     * @param team           团队全部成员（可为 null）
     * @param excludeAgentId 需要剔除的自身 id
     * @param emptyText      名单为空时的占位文案
     */
    public static String roster(List<AgentVO> team, Long excludeAgentId, String emptyText) {
        List<AgentVO> others = team == null ? Collections.emptyList() : team.stream()
                .filter(agent -> agent != null && agent.getId() != null && !agent.getId().equals(excludeAgentId))
                .toList();
        if (others.isEmpty()) return emptyText;

        List<String> teamDes = others.stream().map(TeamPromptComposer::describeAgent).toList();
        return "\n\n ### 成员名单(TEAM ROSTER)" +
                String.join("\n", teamDes);
    }

    private static String describeAgent(AgentVO agent) {
        String teammateName = agent.getName();
        String teammateDes = agent.getDescription();

        if (teammateName == null || teammateName.isEmpty()) {
            teammateName = "未知成员";
        }
        if (teammateDes == null || teammateDes.isEmpty()) {
            teammateDes = "未提供能力描述";
        }

        return String.format("""
                        - id: %s \n
                        - name: %s \n
                        - description: %s \n
                        """,
                agent.getId(), teammateName, teammateDes
        );
    }
}
