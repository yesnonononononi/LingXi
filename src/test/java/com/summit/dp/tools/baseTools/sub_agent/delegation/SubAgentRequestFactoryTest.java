package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.tool.ToolExecution;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.baseTools.arguments.CallSubAgentToolArgument;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 委派出去的子执行必须拿到「成员版」上下文：
 * <ul>
 *   <li>属性里带 {@code TEAM_ID}（成员也有 {@code send_mail_to_agent}，发信要用团队快照）；</li>
 *   <li>工具清单里有 {@code send_mail_to_agent}，但<b>永远没有</b> {@code call_sub_agent}；</li>
 *   <li>系统提示词里带上与指挥者同一份的团队成员名单；</li>
 *   <li>{@code messages} 是执行期历史唯一来源：复用时要带上既有历史，首派时只有本次任务。</li>
 * </ul>
 */
class SubAgentRequestFactoryTest {

    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final ModelService modelService = mock(ModelService.class);
    private final SettingsProvider settingsProvider = mock(SettingsProvider.class);
    private final WorkspaceConverter workspaceConverter = mock(WorkspaceConverter.class);

    private final SubAgentRequestFactory factory = new SubAgentRequestFactory(
            workspaceService, modelService, settingsProvider, workspaceConverter);

    @Test
    @DisplayName("子执行：带 TEAM_ID、带发信工具、不带委派工具，并带上团队成员名单")
    void childRequestCarriesTeamIdAndMailButNeverDelegation() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        AgentVO commander = agent(5L, "产品经理", "你是产品经理");
        TeamVO team = TeamVO.builder().id(3L).name("summit软件开发组").commanderAgentId(5L)
                .agents(List.of(commander, member)).build();
        ToolExecution toolExecution = ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5", ExecutionAttributes.TEAM_ID, "3"))
                .build();

        AgentRequest request = build(member, team, toolExecution);

        // 1) 属性：TEAM_ID 随委派下行，身份链完整
        Map<String, Object> attributes = request.runtimeParametersOrDefault().getAttributes();
        assertEquals("3", attributes.get(ExecutionAttributes.TEAM_ID), "成员要能发信，必须拿到团队快照");
        assertEquals("6", attributes.get(ExecutionAttributes.AGENT_ID));
        assertEquals("1234", attributes.get(ExecutionAttributes.SESSION_ID));
        assertEquals("900", attributes.get(ExecutionAttributes.ROOT_EXECUTION_ID));

        // 2) 工具清单：给发信，绝不给委派
        List<String> tools = request.getToolList();
        assertTrue(tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT), "成员要能和队友同步信息");
        assertFalse(tools.contains(ToolCatalog.CALL_SUB_AGENT), "委派只发生在指挥者这一层");
        assertTrue(tools.contains("read_file"), "Agent 自身配置的工具保留");

        // 3) 提示词：与指挥者同一份成员名单 + 成员职责话术
        String prompt = request.getSystemPrompt();
        assertTrue(prompt.contains("### 成员名单(TEAM ROSTER)"), "名单标题与指挥者同一份渲染");
        assertTrue(prompt.contains("- id: 5") && prompt.contains("- name: 产品经理")
                        && prompt.contains("- description: 未提供能力描述"),
                "名单用与指挥者相同的多行格式渲染；描述缺失时用统一兜底文案");
        assertFalse(prompt.contains("- id: 6"), "成员名单里不含自己");
        assertFalse(prompt.contains("# 可委派队友"), "成员没有可委派队友");
    }

    @Test
    @DisplayName("父执行没有团队时：不凭空给子执行写 TEAM_ID")
    void childRequestOmitsTeamIdWhenParentHasNone() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        ToolExecution toolExecution = ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5"))
                .build();

        AgentRequest request = build(member, TeamVO.builder().id(3L).commanderAgentId(5L)
                .agents(List.of(member)).build(), toolExecution);

        assertNull(request.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.TEAM_ID));
    }

    @Test
    @DisplayName("成员没配工具清单：至少给发信能力，不再是一个工具都没有")
    void unconfiguredMemberStillGetsMail() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        member.setToolList(null);

        AgentRequest request = build(member, TeamVO.builder().id(3L).commanderAgentId(5L)
                .agents(List.of(member)).build(), ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5", ExecutionAttributes.TEAM_ID, "3"))
                .build());

        assertEquals(List.of(ToolCatalog.SEND_MAIL_TO_AGENT), request.getToolList());
    }

    @Test
    @DisplayName("首派：messages 只有本次任务，不带任何历史")
    void freshDelegationCarriesOnlyCurrentTask() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        AgentRequest request = build(member, teamOf(member), parentToolExecution(), List.of());

        List<Message> messages = request.getMessages();
        assertEquals(1, messages.size());
        assertTrue(messages.getFirst().text().contains("请只回复一个词：ok"));
    }

    @Test
    @DisplayName("复用：messages 为「既有历史 + 本次任务」，且本次任务在末位")
    void reusedDelegationAppendsTaskAfterHistory() {
        stubModel();

        AgentVO member = agent(6L, "架构师", "你是架构师");
        List<Message> prior = List.of(
                UserMessageEntity.from("上次的任务"),
                UserMessageEntity.from("上次的追问"));

        AgentRequest request = build(member, teamOf(member), parentToolExecution(), prior);

        List<Message> messages = request.getMessages();
        assertEquals(3, messages.size(), "历史两条 + 本次任务一条");
        assertTrue(messages.get(0).text().contains("上次的任务"));
        assertTrue(messages.get(1).text().contains("上次的追问"));
        assertTrue(messages.getLast().text().contains("请只回复一个词：ok"));
    }

    @Test
    @DisplayName("子 Agent 未绑定模型：直接报错，不静默继承父任务模型")
    void missingModelFailsFast() {
        AgentVO member = agent(6L, "架构师", "你是架构师");
        member.setModelId(null);

        org.junit.jupiter.api.Assertions.assertThrows(com.summit.dp.shared.exception.ClientException.class,
                () -> build(member, teamOf(member), parentToolExecution(), List.of()));
    }

    private AgentRequest build(AgentVO member, TeamVO team, ToolExecution toolExecution) {
        return build(member, team, toolExecution, List.of());
    }

    private AgentRequest build(AgentVO member, TeamVO team, ToolExecution toolExecution, List<Message> priorMessages) {
        CallSubAgentToolArgument argument = new CallSubAgentToolArgument();
        argument.setAgentId(member.getId());
        argument.setTask("请只回复一个词：ok");
        argument.setPrompt("这是委派上下文");
        return factory.build(argument, member, team, toolExecution, null, "1234", null, priorMessages);
    }

    private static TeamVO teamOf(AgentVO member) {
        return TeamVO.builder().id(3L).commanderAgentId(5L).agents(List.of(member)).build();
    }

    private static ToolExecution parentToolExecution() {
        return ToolExecution.builder()
                .executionId("900")
                .attributes(Map.of(ExecutionAttributes.AGENT_ID, "5", ExecutionAttributes.TEAM_ID, "3"))
                .build();
    }

    private void stubModel() {
        when(settingsProvider.current()).thenReturn(Optional.empty());
        when(modelService.runtimeConfig(anyLong(), any())).thenReturn(ModelConfig.builder()
                .baseUrl("https://example.invalid").apiKey("k").modelName("m").build());
        when(workspaceService.findByDir(anyString())).thenReturn(Result.success(null));
    }

    private static AgentVO agent(Long id, String name, String prompt) {
        AgentVO agent = new AgentVO();
        agent.setId(id);
        agent.setName(name);
        agent.setPrompt(prompt);
        agent.setModelId(4L);
        agent.setToolList(List.of("read_file", ToolCatalog.CALL_SUB_AGENT, "execute_command"));
        return agent;
    }
}
