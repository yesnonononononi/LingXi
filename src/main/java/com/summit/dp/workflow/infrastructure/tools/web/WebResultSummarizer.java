package com.summit.dp.workflow.infrastructure.tools.web;

import com.summit.core.conversation.api.ChatRequestEntity;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.chat.ChatModel;
import lombok.extern.slf4j.Slf4j;

import java.util.List;

/**
 * 网页检索结果的摘要器：把原始检索 JSON 交给小模型压缩成可读摘要。
 *
 * <p>契约：<b>摘要失败一律返回 {@code null}</b>，绝不把原始内容当作"摘要结果"返回。
 * 早期实现在异常时返回原始 JSON，导致摘要链路的返回值其实是一大坨 JSON，
 * 既没有摘要价值，又可能超过工具输出上限被框架截成半截 JSON。
 * 现在由调用方 {@link WebSearchEngine} 判断 {@code null} 后走显式降级分支
 * （加标记 + 按输出上限裁剪）。</p>
 */
@Slf4j
public class WebResultSummarizer {

    public static final String DEFAULT_SUMMARY_SYSTEM_PROMPT = """
            You are a helpful web search summarization assistant.
            Analyze and summarize the provided web search results clearly, objectively, and concisely.
            Extract key facts, findings, and essential information while filtering out noise, advertisements, navigation text, and redundant content.
            Retain critical sources, links/URLs, dates, and figures when relevant.
            Organize the summary into a well-structured and readable format.
            """;

    private final ChatModel chatModel;
    private final String systemPrompt;

    public WebResultSummarizer(ChatModel chatModel) {
        this(chatModel, DEFAULT_SUMMARY_SYSTEM_PROMPT);
    }

    public WebResultSummarizer(ChatModel chatModel, String systemPrompt) {
        this.chatModel = chatModel;
        this.systemPrompt = (systemPrompt != null && !systemPrompt.isBlank()) ? systemPrompt : DEFAULT_SUMMARY_SYSTEM_PROMPT;
    }

    /**
     * 生成检索结果摘要。
     *
     * @param webSearchResultStr 原始检索结果字符串，允许为 {@code null}
     * @return 非空摘要文本；输入为空、模型未返回有效文本或调用过程抛异常时返回 {@code null}，
     *         由调用方决定如何降级
     */
    public String summary(String webSearchResultStr) {
        if (webSearchResultStr == null || webSearchResultStr.isBlank()) {
            log.warn("网页摘要跳过: reason=输入为空");
            return null;
        }
        try {
            ChatResponseEntity chatResponse = this.chatModel.chat(ChatRequestEntity.builder()
                    .messages(List.of(
                            SystemMessageEntity.builder()
                                    .text(this.systemPrompt)
                                    .build(),
                            UserMessageEntity.from("Web search results to summarize:\n\n" + webSearchResultStr)
                    ))
                    .build());
            String summaryText = chatResponse == null || chatResponse.getAiMessageEntity() == null
                    ? null
                    : chatResponse.getAiMessageEntity().text();
            if (summaryText == null || summaryText.isBlank()) {
                log.warn("生成网页摘要失败，返回 null 交由调用方降级: reason=模型未返回有效文本");
                return null;
            }
            return summaryText;
        } catch (Exception e) {
            // 异常一律转成 null（不返回原始内容），降级由 WebSearchEngine 统一处理。
            log.warn("生成网页摘要失败，返回 null 交由调用方降级: reason=摘要异常", e);
            return null;
        }
    }
}
