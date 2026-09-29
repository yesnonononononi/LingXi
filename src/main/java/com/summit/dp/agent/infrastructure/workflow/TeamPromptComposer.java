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

    /** 指挥者视角的名单标题。 */
    private static final String COMMANDER_ROSTER_TITLE = "# 可委派队友";

    /** 成员视角的名单标题：同一份名单，但成员不能委派，所以不叫「可委派队友」。 */
    private static final String MEMBER_ROSTER_TITLE = "# 团队成员";

    private TeamPromptComposer() {
    }

    /**
     * 指挥者提示词：人设 + 协作职责 + 可委派队友名单。
     *
     * @param defaultPrompt     Agent 自身人设
     * @param team              团队全部成员（可为 null）
     * @param commanderAgentId  指挥者自身 id，从名单中剔除
     */
    public static String commanderPrompt(String defaultPrompt, List<AgentVO> team, Long commanderAgentId) {
        String roster = roster(team, commanderAgentId, "（无可委派队友；请自行完成任务）");
        return String.format("""
                %s
                
                # 多 Agent 协作职责
                你是团队的 Commander，对用户最终结果负责。简单任务直接完成；只有任务可明确拆分、需要专业能力或交叉验证以及超过1个队友才能更好完成时,
                根据队友的职责范围拆分用户给的任务,拆分完全后**同时**分配给队友以确保任务在理想最小时间内完成。
                委派时，为每个 SubAgent 提供清晰且尽量不重叠的任务、必要背景、约束和期望输出格式。
                收到 SubAgent 结果后，必须检查完整性与可信度、处理冲突、去除重复，并结合用户原始请求形成统一答案；禁止把原始结果简单拼接给用户。
                默认由你自己完成汇总。仅当结果较多、上下文很长、冲突明显，且队伍中存在职责匹配的汇总或审校 Agent 时，才委派汇总；其结果仍须由你最终检查和作答。
                不要调用自己，不要为同一任务重复委派，也不要调用下列名单之外的 Agent。某个 Agent 失败时，说明影响并尽可能使用已有信息继续完成。
                %s
                %s
                """, defaultPrompt == null ? "" : defaultPrompt.trim(), COMMANDER_ROSTER_TITLE, roster);
    }

    /**
     * 团队成员提示词：人设 + 协作职责（无委派能力）+ 团队成员名单。
     *
     * @param defaultPrompt Agent 自身人设
     * @param team          团队全部成员（可为 null）
     * @param memberAgentId 成员自身 id，从名单中剔除
     */
    public static String memberPrompt(String defaultPrompt, List<AgentVO> team, Long memberAgentId) {
        String roster = roster(team, memberAgentId, "（暂无其他团队成员）");
        return String.format("""
                %s
                
                # 多 Agent 协作职责
                你是本次多 Agent 协作的团队成员，对 Commander 交给你的任务负责。
                按 Commander 给出的任务、必要背景、约束与期望输出格式独立完成工作，并把结论一次性返回给 Commander。
                需要与团队中的某个 Agent 同步信息、提出新需求或反馈阻塞时，调用 send_mail_to_agent，收件人从下面的名单里选 id。
                你没有委派能力（没有 call_sub_agent），不要尝试把任务转派给其他 Agent；也不要调用下列名单之外的 Agent。
                %s
                %s
                """, defaultPrompt == null ? "" : defaultPrompt.trim(), MEMBER_ROSTER_TITLE, roster);
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
        return others.isEmpty()
                ? emptyText
                : others.stream().map(TeamPromptComposer::describeAgent).collect(Collectors.joining("\n"));
    }

    private static String describeAgent(AgentVO agent) {
        String name = agent.getName() == null || agent.getName().isBlank() ? "未命名" : agent.getName().trim();
        String description = agent.getDescription() == null || agent.getDescription().isBlank()
                ? "未提供能力描述" : agent.getDescription().trim();
        return String.format("- id: %s | name: %s | description: %s", agent.getId(), name, description);
    }
}
