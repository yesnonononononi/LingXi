package com.summit.dp.workflow.application.chat;

import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.team.application.vo.TeamVO;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.core.env.MapPropertySource;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class BusinessSystemPromptBuilderTest {

    @Test
    void rootKeepsGlobalRulesBeforeRoleAndPreservesInternalNewlines() {
        BusinessSystemPromptBuilder builder = new BusinessSystemPromptBuilder("  全局规则\n第二条  ");
        assertEquals("全局规则\n第二条\n\n角色提示", builder.buildRootPrompt("  角色提示  "));
        assertEquals("全局规则\n第二条\n\n另一个角色", builder.buildRootPrompt("另一个角色"));
    }

    @Test
    void emptySectionsDoNotLeaveSeparators() {
        BusinessSystemPromptBuilder configured = new BusinessSystemPromptBuilder(" 全局规则 ");
        assertEquals("全局规则", configured.buildRootPrompt(null));
        assertEquals("全局规则", configured.buildRootPrompt(" \n "));

        BusinessSystemPromptBuilder empty = new BusinessSystemPromptBuilder(null);
        assertEquals("角色提示", empty.buildRootPrompt(" 角色提示 "));
        assertEquals("", empty.buildRootPrompt(null));
        assertEquals("", new BusinessSystemPromptBuilder(" \n ").buildRootPrompt(" \n "));
    }

    @Test
    void memberKeepsRoleRosterAndDelegationContextInOrder() {
        AgentVO member = new AgentVO();
        member.setId(6L);
        member.setPrompt("成员人设");
        AgentVO commander = new AgentVO();
        commander.setId(5L);
        commander.setName("主理人");
        TeamVO team = TeamVO.builder().commanderAgentId(5L).description("团队描述")
                .agents(List.of(member, commander)).build();

        String prompt = new BusinessSystemPromptBuilder("全局规则")
                .buildMemberPrompt(member, team, "  本次任务上下文  ");

        assertTrue(prompt.startsWith("成员人设\n"));
        assertTrue(prompt.contains("团队描述"));
        assertTrue(prompt.contains("- id: 5"));
        assertFalse(prompt.contains("- id: 6"));
        assertTrue(prompt.endsWith("# Commander 提供的任务上下文\n本次任务上下文\n"));
        assertTrue(prompt.indexOf("成员名单") < prompt.indexOf("# Commander 提供的任务上下文"));
        assertFalse(prompt.contains("全局规则"));
    }

    @Test
    void memberAcceptsMissingTeamAndCallerContext() {
        AgentVO member = new AgentVO();
        member.setId(6L);
        member.setPrompt("成员人设");

        String prompt = new BusinessSystemPromptBuilder("").buildMemberPrompt(member, null, null);
        assertTrue(prompt.contains("主理人的 agentId 是 未提供"));
        assertTrue(prompt.contains("（暂无其他团队成员）"));
        assertTrue(prompt.endsWith("# Commander 提供的任务上下文\n\n"));
    }

    @Test
    void springInjectsTheConfiguredGlobalPrompt() {
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
            context.getEnvironment().getPropertySources().addFirst(
                    new MapPropertySource("提示词测试", Map.of("lingxi.system-prompt", "配置规则")));
            context.register(BusinessSystemPromptBuilder.class);
            context.refresh();
            assertEquals("配置规则\n\n角色提示",
                    context.getBean(BusinessSystemPromptBuilder.class).buildRootPrompt("角色提示"));
        }
    }
}
