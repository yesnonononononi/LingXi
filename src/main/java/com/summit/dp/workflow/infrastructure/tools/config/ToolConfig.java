package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCallKeys;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import java.io.Serializable;
import java.util.Optional;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 计划附件需要仓储与转换器协作，保留显式装配。 */
@Configuration(proxyBeanMethods = false)
public class ToolConfig {

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
