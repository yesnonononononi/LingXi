package com.summit.dp.tools.baseTools.web;

import com.summit.core.conversation.api.ChatRequestEntity;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.model.chat.ChatModel;
import lombok.extern.slf4j.Slf4j;

import java.util.List;

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

    public String summary(String webSearchResultStr) {
        try {
            ChatResponseEntity chatResponse = this.chatModel.chat(ChatRequestEntity.builder()
                    .messages(List.of(
                            SystemMessageEntity.builder()
                                    .text(this.systemPrompt)
                                    .build(),
                            UserMessageEntity.from("Web search results to summarize:\n\n" + webSearchResultStr)
                    ))
                    .build());
            return chatResponse.getAiMessageEntity().text();
        } catch (Exception e) {
            log.warn("Summary the result of web content has happened a error.return original str to model", e);
            return webSearchResultStr;
        }
    }
}
