package com.summit.dp.tools.baseTools.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.workflow.TeamPromptComposer;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.tools.baseTools.sub_agent.CallSubAgentTool;
import com.summit.dp.tools.baseTools.sub_agent.communication.SendMailToAgentTool;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * 交付总监独立验证（QA 严过关）—— T02（工具定义 / 提示词纠偏）对抗性用例。
 *
 * <p>两支独立证据：① {@code memberPrompt} <b>渲染出的字符串</b>里出现主理人 agentId
 * （用正则锁死整句，避免「名单里恰好也有这个 id」的假绿）；② {@code send_mail_to_agent}
 * 的 description 与 {@code toAgentId} 描述已是<b>双向</b>措辞。</p>
 */
class QaToolDefinitionAndPromptTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final EmailService emailService = mock(EmailService.class);

    private static AgentVO agent(Long id, String name, String description) {
        AgentVO vo = new AgentVO();
        vo.setId(id);
        vo.setName(name);
        vo.setDescription(description);
        return vo;
    }

    @Test
    @DisplayName("T02 memberPrompt：渲染结果里出现主理人 agentId（正则锁整句，非仅方法签名）")
    void memberPromptRendersCommanderAgentId() {
        // 主理人 77，成员 88；名单里天然也含 77，正则必须锁到「主理人的 agentId 是 77」整句。
        List<AgentVO> team = List.of(agent(77L, "交付总监", "统筹"), agent(88L, "工程师", "写代码"));

        String prompt = TeamPromptComposer.memberPrompt("人设", team, 88L, 77L, "协作团队");

        assertTrue(Pattern.compile("主理人的 agentId 是 77").matcher(prompt).find(),
                "必须显式渲染出主理人 agentId 整句，否则成员只能从名单猜 id");
        assertTrue(prompt.contains("send_mail_to_agent"), "成员须知道补充通知的工具");
        assertTrue(prompt.contains("只发一次"), "须约束只发一次，避免重复投递");
    }

    @Test
    @DisplayName("T02 memberPrompt：主理人 id 缺失时用占位文案，不产生 null 字面量")
    void memberPromptHandlesMissingCommander() {
        String prompt = TeamPromptComposer.memberPrompt("人设", List.of(agent(88L, "工程师", "x")), 88L, null, "团队");
        assertTrue(prompt.contains("主理人的 agentId 是 未提供"));
        assertFalse(prompt.contains("null"));
    }

    @Test
    @DisplayName("T02 call_sub_agent schema：不再有 runtime_mode（收敛为单一异步口径），必填仍为 agentId/task")
    void callSubAgentSchemaHasNoRuntimeMode() throws Exception {
        ToolDefinition<CallSubAgentTool> definition =
                new ToolConfig().callSubAgentToolDefinition(mock(CallSubAgentTool.class));

        assertEquals(ToolCatalog.CALL_SUB_AGENT, definition.name());
        JsonNode schema = objectMapper.readTree(definition.parametersJsonSchema());

        assertTrue(schema.get("properties").get("runtime_mode") == null,
                "双模式已收敛为单一异步口径，schema 不得再暴露 runtime_mode");
        assertFalse(definition.description().contains("runtime_mode"));
        assertTrue(definition.description().contains("blocking") == false, "不得再暴露 blocking 分叉");

        Set<String> required = new TreeSet<>();
        schema.get("required").forEach(node -> required.add(node.asText()));
        assertEquals(Set.of("agentId", "task"), required);
        assertFalse(schema.get("additionalProperties").asBoolean(true));
    }

    @Test
    @DisplayName("T02 call_sub_agent description：单一异步口径，且验收以产物与验证记录为准、内部故障自行处理")
    void callSubAgentDescriptionDescribesSingleAsyncMode() {
        String description = new ToolConfig().callSubAgentToolDefinition(mock(CallSubAgentTool.class)).description();

        assertFalse(description.contains("blocking"), "阻塞式委派已删除，描述不得再提 blocking");
        assertFalse(description.contains("runtime_mode"), "描述不得再提 runtime_mode");
        assertTrue(description.toLowerCase().contains("asynchron"), "须说明委派是异步协作式");
        assertTrue(description.contains("email (send_mail_to_agent) is supplementary"));
        assertTrue(description.contains("Verify workspace artifacts and validation records"));
        assertTrue(description.contains("Handle these internal failures yourself"));
    }

    @Test
    @DisplayName("T02 send_mail_to_agent：description 与 toAgentId 描述均为双向措辞")
    void sendMailDefinitionIsBidirectional() throws Exception {
        ToolDefinition<SendMailToAgentTool> definition =
                new ToolConfig().sendMailToAgentToolToolDefinition(objectMapper, emailService, mock(ExecutionResumeCoordinator.class));

        String description = definition.description();
        assertTrue(description.toLowerCase().contains("commander"),
                "description 须承认「发给主理人」这一方向");
        assertTrue(description.toLowerCase().contains("teammate"),
                "description 须承认「发给队友」这一方向");
        assertTrue(description.contains("asynchronous"),
                "须点明投递是异步的，否则模型会以为发完就能同步拿到回复");
        assertTrue(description.contains("even without email"));

        JsonNode schema = objectMapper.readTree(definition.parametersJsonSchema());
        String toAgentId = schema.get("properties").get("toAgentId").get("description").asText();
        assertTrue(toAgentId.toLowerCase().contains("commander"),
                "toAgentId 描述必须对「成员发回主理人」这一方向成立");
        assertTrue(toAgentId.toLowerCase().contains("teammate"),
                "toAgentId 描述必须对「主理人发给成员」这一方向成立");
    }
}
