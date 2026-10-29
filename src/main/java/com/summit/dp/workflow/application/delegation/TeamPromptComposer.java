package com.summit.dp.workflow.application.delegation;

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
                 - 委派为协作式：受理后你继续推进其它主线步骤；交付说明与邮件都不是验收依据，必须核验成员工作目录中的实际产物与验证记录，没有可用成果就重新委派。
                 - 可用 `send_mail_to_agent` 向正在执行任务的队员补充需求、约束、接口约定或新发现；邮件由队员下一次模型调用前读取，不会启动或恢复队员。
                 - 队员遇到同一文件或工作区时可直接邮件协商修改范围、顺序和交接，日常协调无需通知你；只有无法解决的冲突、任务范围变更或需要你决策的阻塞才升级给你。
                 - 委派时明确交付格式：改动文件清单、自检结论（实际执行的命令与结果）、未决项；没有未决项也要明确写出。
                # 注意项 :
                 - 不要调用自己，不要在同一任务仍在执行时重复委派，也不要调用下列名单之外的 Agent。
                 - 启动新任务或重新启动已结束的队员只用 `call_sub_agent`；队员仍在执行时，补充信息用邮件，不要重复委派。
                 - 不要用 `send_mail_to_agent` 启动任务或反复催办；队员已结束时邮件只会保留待处理，直到它再次执行才可能读取。
                 - 收口由你负责：核对文件是否真正落盘、内容是否符合任务，亲自执行适用门禁；修复缺陷时还要确认回退能让回归用例变红。成员声称完成不等于验收通过。
                 - 没收到邮件、返回为空或交付含糊时，先自行读文件、跑验证；确实没有产出或成员执行失败时，由你补做或重新委派，并再次明确上述交付格式，不把这些内部故障转交用户决策。
                 - 子任务仍在执行时继续独立工作或者结束等待任务交付唤醒，不能把受理回执、过程消息或缺少邮件当成完成证据；只有真实缺失的用户信息或授权才需要用户决策。
                %s
                """, defaultPrompt, teamDescription, roster);
    }

    /**
     * 团队成员提示词：人设 + 协作职责（无委派能力）+ 团队成员名单。
     *
     * @param defaultPrompt    Agent 自身人设
     * @param team             团队全部成员（可为 null）
     * @param memberAgentId    成员自身 id，从名单中剔除
     * @param commanderAgentId 主理人 id；写进提示词，成员发信时据此填 {@code toAgentId}
     * @param teamDescription  团队描述
     */
    public static String memberPrompt(String defaultPrompt, List<AgentVO> team, Long memberAgentId,
                                      Long commanderAgentId, String teamDescription) {
        String roster = roster(team, memberAgentId, "（暂无其他团队成员）");
        String commander = commanderAgentId == null ? "未提供" : String.valueOf(commanderAgentId);
        return String.format("""
                %s
                #### **团队协作模式(TEAM COORDINATION MODE)**
                ### 团队描述(TEAM DESCRIPTION)
                %s
                ### 成员职责
                # 身份 :
                 - 你是本次参与协作的团队成员，负责完成主理人交给你的任务，最终交付必须包含改动文件清单、自检结论（实际执行的命令与结果）、未决项；没有未决项也要明确写出。
                # 协作能力 :
                 - 遇到与队友修改同一文件或使用同一工作区时，可用 `send_mail_to_agent` 直接协商，无需通知主理人。写明文件路径、准备修改的范围、执行顺序和交接条件，避免覆盖彼此的改动。
                 - 日常协调由你们自行解决；只有协商无法解决的冲突、任务范围变更或需要主理人决策的阻塞才通知主理人。队员互发邮件不会通知或唤醒主理人。
                 - 主理人也可以发邮件补充需求、约束或新发现。每次收到邮件后结合当前任务处理，需要协调时直接回复对应发件人。
                 - 邮件异步送达，在收件人下一次模型调用前读取；发送调用不返回回复，也不会启动或恢复已结束的队员。不要因为暂未回信就重发。
                 - 共享修改需要对方确认时，先推进不冲突的独立工作；未收到回复不等于同意，不要抢写或覆盖。若无法继续且需要重新启动队友，再向主理人说明阻塞。
                # 注意项 :
                 - 你没有委派能力（没有 call_sub_agent），不要尝试把任务转派给其他 Agent；也不要调用下列名单之外的 Agent。
                 - 你交付时必须把产物和验证记录写入工作目录，并在最终结果中列出路径。可用 `send_mail_to_agent` 补充通知，相同交付只发一次；主理人的 agentId 是 %s。
                 - 交付通知只是补充，主理人会核验产物；不能用“已完成”声明代替落盘文件和实际验证，未运行的检查必须如实说明。
                 - 最终结果交付给主理人；队员之间的日常协调无需抄送或逐条汇报
                 - 不要越过职责范围执行其他成员的工作,保持上下文干净
                %s
                """, defaultPrompt, teamDescription, commander, roster);
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
