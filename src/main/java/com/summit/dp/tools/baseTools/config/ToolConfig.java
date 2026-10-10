package com.summit.dp.tools.baseTools.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.tools.baseTools.plan.CreatePlanTool;
import com.summit.dp.tools.baseTools.sub_agent.CallSubAgentTool;
import com.summit.dp.tools.baseTools.require_choice.RequireChoiceToolExecutor;
import com.summit.dp.tools.baseTools.sub_agent.communication.SendMailToAgentTool;
import lombok.Builder;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.io.Serializable;
import java.util.Optional;

/**
 * 应用内全部工具的执行器装配与 {@link ToolDefinition} 注册入口。
 */
@Configuration(proxyBeanMethods = false)
public class ToolConfig {

    @Bean
    public ToolDefinition<RequireChoiceToolExecutor> requireChoiceTool(
            RequireChoiceToolExecutor executor) {
        return ToolDefinition.<RequireChoiceToolExecutor>builder()
                .id("require_choice")
                .name("require_choice")
                .executor(executor)
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .description("Ask the user a question and wait for an explicit answer.")
                .parametersJsonSchema("""
                        {"type":"object","properties":{"question":{"type":"string"},
                        "options":{"type":"array","items":{"type":"string"}}},
                        "required":["question"]}
                        """)
                .maxOutput(1_000)
                .timeout(300L)
                .build();
    }

    @Bean
    public ToolDefinition<CallSubAgentTool> callSubAgentToolDefinition(CallSubAgentTool executor) {
        return ToolDefinition.<CallSubAgentTool>builder()
                .id(ToolCatalog.CALL_SUB_AGENT)
                .name(ToolCatalog.CALL_SUB_AGENT)
                .executor(executor)
                .description("""
                        Delegate one well-scoped task to a configured teammate.
                        The delegation is accepted immediately; the teammate runs asynchronously so you keep working on the rest of the round. Verify workspace artifacts and validation records yourself; email (send_mail_to_agent) is supplementary and is not the basis for acceptance.
                        Require a changed-file list, actual validation commands and results, and unresolved items. If delivery is empty or unclear, inspect files and run checks yourself; if there is no usable output or the teammate fails, complete the work or re-delegate with this explicit format. Handle these internal failures yourself.
                        """)
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "agentId": {"type": "integer", "description": "Agent id from the commander's teammate list."},
                            "task": {"type": "string", "description": "A concrete, self-contained task for the teammate."},
                            "prompt": {"type": "string", "description": "Relevant context, constraints and expected output format."},
                            "workDir": {"type": "string", "description": "Current workspace directory."},
                            "agentName": {"type": "string", "description": "The name of the target agent."}
                          },
                          "required": ["agentId", "task"],
                          "additionalProperties": false
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.ISOLATED_MUTATION)
                .maxOutput(20_000)
                .timeout(36_000L)
                .build();
    }
    /**
     * 发信工具定义。
     *
     * <p>{@code description} 必须讲清<b>投递是异步的</b>：对方要等到它自己的下一次模型调用
     * 才会读到这封信。这既符合实现（{@code EmailService.sendMail} 只落一条 PENDING 消息，
     * 由收件方的 {@code AgenticLoopInterceptor} 在其下一轮消费），也是压住「发完不放心、再发一封」
     * 这类行为的关键——曾观测到同一执行在 2.7 秒内发出两封内容完全相同的邮件。</p>
     *
     * <p>文案还刻意点明这是<b>编码协作</b>用途而非即时聊天：本工具没有回执通道，
     * 不该被用于「一问一答」的往返等待。措辞保持英文以与其余工具定义一致。</p>
     *
     * <p><b>双向用途</b>：这条描述对主理人（发给成员）与成员（把结果发回主理人）都要成立 ——
     * 邮件仅补充交付通知，主理人仍须核验产物与验证记录。</p>
     */
    @Bean
    public ToolDefinition<SendMailToAgentTool> sendMailToAgentToolToolDefinition(ObjectMapper objectMapper,
                                                                                EmailService emailService,
                                                                                ExecutionResumeCoordinator resumeCoordinator) {
        return ToolDefinition.<SendMailToAgentTool>builder()
                .id(ToolCatalog.SEND_MAIL_TO_AGENT)
                .name(ToolCatalog.SEND_MAIL_TO_AGENT)
                .executor(new SendMailToAgentTool(objectMapper, emailService, resumeCoordinator))
                .description("""
                        Send an asynchronous mail to a teammate agent or to the commander.
                        Use it for supplementary delivery notifications; the commander assesses workspace artifacts and validation records even without email, and email is not the basis for acceptance.
                        Delivery is asynchronous: the recipient reads this mail at the start of ITS next model round,
                        not immediately. There is no reply channel on this call, so sending does not return an answer.
                        After a successful send, continue with your own work, or if you have nothing left to do,
                        end your turn and wait for incoming mail; never resend the same content because no reply arrived yet.
                        Intended for code-collaboration hand-offs, not for real-time back-and-forth chat.
                        The target agent must belong to your team.
                        """)
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "toAgentId": {"type": "integer", "description": "Agent id of the recipient: a teammate, or the commander when a member sends its result back."},
                            "mailContent": {"type": "string", "description": "The mail body. Write it as a complete, self-contained message; the recipient cannot ask clarifying questions synchronously."}
                          },
                          "required": ["toAgentId", "mailContent"],
                          "additionalProperties": false
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.ISOLATED_MUTATION)
                .maxOutput(20_000)
                .timeout(60L)
                .build();
    }
    @Bean
    public ToolDefinition<CreatePlanTool> createPlanToolToolDefinition(CreatePlanTool createPlanTool) {
        return ToolDefinition.<CreatePlanTool>builder()
                .id(ToolCatalog.CREATE_PLAN)
                .name(ToolCatalog.CREATE_PLAN)
                .executor(createPlanTool)
                .description("""
                        Create a plan for the given task.
                        The user may have embedded some tips in your plan so it is common if you see  other text that differs from the original plan text.
                        However, you don't ignore them.
                        """)
                .parametersJsonSchema("""
                        {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string", "description": "The title of the plan to create."},
                            "text" : {"type": "string", "description": "The text of the plan to create. it is displayed by the format of MARKDOWN"}
                        },
                        "required": ["title"],
                        "additionalProperties": false
                        }
                        """)
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .timeout(6_000L)
                .maxOutput(5_000)
                .build();
    }

    /**
     * 上下文压缩时的计划书附件：框架传入的键是<b>执行 id</b>。
     *
     * <p>计划书正文现存放于 {@code tool_call.content}（{@code kind=PLAN}）；按
     * {@code execution_id} 取本执行<b>最后一条</b> PLAN 卡片即可拿回正文，无需再经快照行二次回查。</p>
     *
     * <p>Bean 名固定为 {@code contextAttachmentProvider}：框架兜底 Bean 用
     * {@code @ConditionalOnMissingBean(name = "contextAttachmentProvider")} 按名字退位，
     * 业务侧改名覆盖它，否则同类型两个 Bean 导致 conversationManager 注入歧义。</p>
     */
    @Bean
    public ContextAttachmentProvider contextAttachmentProvider(ToolCallRepository toolCallRepository,
                                                           ToolCallConverter converter) {
        return executionId -> {
            Long execId = toId(executionId);
            if (execId == null) {
                return Optional.empty();
            }
            return toolCallRepository.listByExecutionId(execId).stream()
                    .filter(toolCall -> toolCall.getType() == ToolCallType.PROMISE)
                    .filter(toolCall -> converter.resolveKind(toolCall.getContent()) == ToolCallKind.PLAN)
                    .reduce((first, second) -> second)   // 取最后一条
                    .map(toolCall -> renderPlanAttachment(converter.parse(toolCall.getContent())));
        };
    }

    /**
     * 附件正文：把 {@code content} 摊成一段可读文本。
     *
     * <p>只输出标题与正文——这是模型压缩上下文后重新理解当前计划所必需的最小信息；
     * 结构化载荷（任务清单、候选选项）不在此展开，模型已在上一轮的工具调用参数里见过。</p>
     */
    private static String renderPlanAttachment(JsonNode content) {
        StringBuilder sb = new StringBuilder();
        if (content != null) {
            String title = content.hasNonNull(ToolCallKeys.TITLE) ? content.get(ToolCallKeys.TITLE).asText() : null;
            String text = content.hasNonNull(ToolCallKeys.TEXT) ? content.get(ToolCallKeys.TEXT).asText() : null;
            if (title != null && !title.isBlank()) {
                sb.append("# ").append(title).append('\n');
            }
            if (text != null && !text.isBlank()) {
                sb.append(text);
            }
        }
        return sb.toString();
    }

    /** 附件提供者收到的是不透明标识，这里做一次显式转换；非数字直接跳过而非抛异常。 */
    private static Long toId(Serializable raw) {
        if (raw == null) return null;
        try {
            return Long.parseLong(String.valueOf(raw));
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
