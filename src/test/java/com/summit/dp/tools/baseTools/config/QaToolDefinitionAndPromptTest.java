package com.summit.dp.tools.baseTools.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.agent.infrastructure.workflow.TeamPromptComposer;
import com.summit.dp.email.application.service.EmailService;
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
        assertTrue(prompt.contains("send_mail_to_agent"), "成员须知道用邮件交付");
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
    @DisplayName("T02 call_sub_agent schema：新增 runtime_mode（enum + default blocking），必填仍为 agentId/task")
    void callSubAgentSchemaCarriesRuntimeMode() throws Exception {
        ToolDefinition<CallSubAgentTool> definition =
                new ToolConfig().callSubAgentToolDefinition(mock(CallSubAgentTool.class));

        assertEquals(ToolCatalog.CALL_SUB_AGENT, definition.name());
        JsonNode schema = objectMapper.readTree(definition.parametersJsonSchema());

        JsonNode runtimeMode = schema.get("properties").get("runtime_mode");
        assertTrue(runtimeMode != null, "schema 必须包含 runtime_mode");
        Set<String> enumValues = new TreeSet<>();
        runtimeMode.get("enum").forEach(node -> enumValues.add(node.asText()));
        assertEquals(Set.of("blocking", "async"), enumValues);
        assertEquals("blocking", runtimeMode.get("default").asText(), "默认必须是阻塞式");

        Set<String> required = new TreeSet<>();
        schema.get("required").forEach(node -> required.add(node.asText()));
        assertEquals(Set.of("agentId", "task"), required, "runtime_mode 不得变成必填");
        assertFalse(schema.get("additionalProperties").asBoolean(true));
    }

    @Test
    @DisplayName("T02 call_sub_agent description：区分两种模式，且不再是误导性的单句「return its final result」")
    void callSubAgentDescriptionDistinguishesModes() {
        String description = new ToolConfig().callSubAgentToolDefinition(mock(CallSubAgentTool.class)).description();

        assertTrue(description.contains("blocking"), "须说明 blocking 语义");
        assertTrue(description.contains("async"), "须说明 async 语义");
        assertTrue(description.toLowerCase().contains("email") || description.contains("send_mail_to_agent"),
                "须说明 async 下结果经邮件送达");
        assertFalse(description.trim().equals(
                "Delegate one well-scoped task to a configured teammate and return its final result."),
                "旧的误导性单句必须被替换");
    }

    @Test
    @DisplayName("T02 send_mail_to_agent：description 与 toAgentId 描述均为双向措辞")
    void sendMailDefinitionIsBidirectional() throws Exception {
        ToolDefinition<SendMailToAgentTool> definition =
                new ToolConfig().sendMailToAgentToolToolDefinition(objectMapper, emailService);

        String description = definition.description();
        assertTrue(description.toLowerCase().contains("commander"),
                "description 须承认「发给主理人」这一方向");
        assertTrue(description.toLowerCase().contains("teammate"),
                "description 须承认「发给队友」这一方向");
        assertTrue(description.contains("async (collaboration) mode"),
                "须点明 async 协作模式下成员用它回传结果");

        JsonNode schema = objectMapper.readTree(definition.parametersJsonSchema());
        String toAgentId = schema.get("properties").get("toAgentId").get("description").asText();
        assertTrue(toAgentId.toLowerCase().contains("commander"),
                "toAgentId 描述必须对「成员发回主理人」这一方向成立");
        assertTrue(toAgentId.toLowerCase().contains("teammate"),
                "toAgentId 描述必须对「主理人发给成员」这一方向成立");
    }
}
