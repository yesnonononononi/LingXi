package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.tools.baseTools.arguments.SendMailArgument;
import com.summit.dp.tools.baseTools.config.ToolConfig;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * 发信工具回归：Schema 与参数类字段名必须一致，且发送者 / 协作根会话（邮箱业务键）/ 根执行
 * （唤醒目标）/ 团队快照一律由服务端从受控上下文解析（模型只能给 {@code toAgentId} 与 {@code mailContent}）。
 *
 * <p>历史缺陷正是这三处不一致：Schema 用 {@code agentId/subject/content}、
 * {@code SendMailArgument} 用别的字段名、工具又把 attributes 里的发送者 ID 直接强转 {@code Long}
 * （而主/子执行写入的是字符串）。</p>
 */
class SendMailToAgentToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final EmailService emailService = mock(EmailService.class);
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);
    private final SendMailToAgentTool tool = new SendMailToAgentTool(objectMapper, emailService,
            resumeCoordinator);

    @Test
    @DisplayName("注册的 JSON Schema 与 SendMailArgument 字段名严格一致，且只有这两个必填项")
    void registeredSchemaMatchesArgumentFields() throws Exception {
        ToolDefinition<SendMailToAgentTool> definition =
                new ToolConfig().sendMailToAgentToolToolDefinition(objectMapper, emailService, mock(ExecutionResumeCoordinator.class));

        assertEquals(ToolCatalog.SEND_MAIL_TO_AGENT, definition.name());

        JsonNode schema = objectMapper.readTree(definition.parametersJsonSchema());
        Set<String> schemaProperties = new LinkedHashSet<>();
        schema.get("properties").fieldNames().forEachRemaining(schemaProperties::add);

        Set<String> argumentFields = Arrays.stream(SendMailArgument.class.getDeclaredFields())
                .map(Field::getName)
                .collect(Collectors.toCollection(LinkedHashSet::new));

        assertEquals(argumentFields, schemaProperties,
                "Schema 属性名与 SendMailArgument 字段名必须一一对应，否则模型调用必然失败");
        assertEquals(Set.of("toAgentId", "mailContent"), schemaProperties,
                "模型只给「发给谁」和「发什么」");

        Set<String> required = new LinkedHashSet<>();
        schema.get("required").forEach(node -> required.add(node.asText()));
        assertEquals(schemaProperties, required, "两个字段都必须必填");

        assertFalse(schema.get("additionalProperties").asBoolean(true),
                "禁止模型塞入 emailId / senderId / 根执行 ID 等路由字段");
    }

    @Test
    @DisplayName("根执行发信：邮箱业务键取 SESSION_ID（根会话），唤醒目标回落到自身 executionId")
    void rootExecutionResolvesSenderAndMailboxFromControlledContext() {
        ToolExecuteResult result = tool.execute(execution("900",
                Map.of(ExecutionAttributes.AGENT_ID, "100",
                        ExecutionAttributes.SESSION_ID, "405"),
                "{\"toAgentId\":7,\"mailContent\":\"你好\"}"));

        assertTrue(result.isSuccess(), result.getToolOutput());
        verify(emailService).sendMail(7L, "你好", new MailSendContext(405L, 100L, null));
        verify(resumeCoordinator).accept(900L);
    }

    @Test
    @DisplayName("子执行发信：邮箱业务键取 ROOT_SESSION_ID，唤醒目标取 ROOT_EXECUTION_ID，团队快照随属性下行")
    void childExecutionResolvesRootSessionAndTeam() {
        ToolExecuteResult result = tool.execute(execution("1234",
                Map.of(ExecutionAttributes.AGENT_ID, "8",
                        ExecutionAttributes.ROOT_SESSION_ID, "405",
                        ExecutionAttributes.ROOT_EXECUTION_ID, "900",
                        ExecutionAttributes.TEAM_ID, "3"),
                "{\"toAgentId\":7,\"mailContent\":\"子代理发的\"}"));

        assertTrue(result.isSuccess(), result.getToolOutput());
        verify(emailService).sendMail(7L, "子代理发的", new MailSendContext(405L, 8L, 3L));
        verify(resumeCoordinator).accept(900L);
    }

    @Test
    @DisplayName("受控上下文缺失或脏值时拒绝发信，不猜身份、不调用服务")
    void rejectsWhenControlledContextIsMissingOrDirty() {
        // 未绑定 Agent
        assertFalse(tool.execute(execution("900", Map.of(),
                "{\"toAgentId\":7,\"mailContent\":\"x\"}")).isSuccess());
        // AGENT_ID 是脏值（历史缺陷：直接强转 Long 会 CCE）
        assertFalse(tool.execute(execution("900", Map.of(ExecutionAttributes.AGENT_ID, "not-a-number"),
                "{\"toAgentId\":7,\"mailContent\":\"x\"}")).isSuccess());
        // 缺 SESSION_ID 且不解析 ROOT_SESSION_ID：算不出邮箱业务键
        assertFalse(tool.execute(execution("900", Map.of(ExecutionAttributes.AGENT_ID, "100"),
                "{\"toAgentId\":7,\"mailContent\":\"x\"}")).isSuccess());

        verifyNoInteractions(emailService);
        verifyNoInteractions(resumeCoordinator);
    }

    @Test
    @DisplayName("参数校验：toAgentId 缺失、正文空白都拒绝，不调用服务")
    void rejectsIncompleteArguments() {
        Map<String, Object> attributes = Map.of(ExecutionAttributes.AGENT_ID, "100",
                ExecutionAttributes.SESSION_ID, "405");

        ToolExecuteResult noTarget = tool.execute(execution("900", attributes, "{\"mailContent\":\"x\"}"));
        assertFalse(noTarget.isSuccess());
        assertTrue(noTarget.getToolOutput().contains("toAgentId"));

        assertFalse(tool.execute(execution("900", attributes,
                "{\"toAgentId\":7,\"mailContent\":\"   \"}")).isSuccess());

        verifyNoInteractions(emailService);
    }

    @Test
    @DisplayName("注册的工具描述必须讲清投递是异步的、且无回复通道")
    void registeredDescriptionExplainsAsynchronousDelivery() throws Exception {
        ToolDefinition<SendMailToAgentTool> definition =
                new ToolConfig().sendMailToAgentToolToolDefinition(objectMapper, emailService, mock(ExecutionResumeCoordinator.class));

        String description = definition.description();
        assertTrue(description.contains("asynchronous"),
                "必须点明投递是异步的，否则模型会以为发完就能同步拿到回复");
        assertTrue(description.contains("next model round"),
                "必须说明对方在它自己的下一轮才读到");
        assertTrue(description.contains("no reply channel"),
                "必须说明本调用不返回回复");
        assertTrue(description.contains("never resend"),
                "必须明确禁止「因为没收到回复就重发」——这正是重复投递的成因");
    }

    @Test
    @DisplayName("成功回执必须与描述同口径：已投递 + 对方下一轮读到 + 不要重发")
    void successAckStatesDeliveryAndAdvisesWaiting() {
        ToolExecuteResult result = tool.execute(execution("900",
                Map.of(ExecutionAttributes.AGENT_ID, "100",
                        ExecutionAttributes.SESSION_ID, "405"),
                "{\"toAgentId\":7,\"mailContent\":\"开场立论\"}"));

        String ack = result.getToolOutput();
        assertTrue(result.isSuccess());
        assertTrue(ack.contains("delivered"), "必须让模型确认这封确实发出去了");
        assertTrue(ack.contains("7"), "回执要带上收件 Agent，便于模型对齐上下文");
        assertTrue(ack.contains("next model round"), "要说明对方何时读到，与工具描述一致");
        assertTrue(ack.contains("do not resend"),
                "必须给出「别重发」的行动指引，掐断「怀疑没发出去 → 重发」的循环");
    }

    private static ToolExecution execution(String executionId, Map<String, Object> attributes, String args) {
        return ToolExecution.builder()
                .executionId(executionId)
                .attributes(attributes)
                .args(args)
                .build();
    }
}
