package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conf.ModelConfig;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import com.summit.dp.workflow.infrastructure.tools.config.properties.WebSearchToolProperties;
import com.summit.dp.workflow.infrastructure.tools.web.WebResultSummarizer;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchConfig;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchEngine;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchExecutor;
import java.net.http.HttpClient;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** 网页检索 Schema 由配置决定，相关模型与属性继续显式装配。 */
@Slf4j
@EnableConfigurationProperties({WebSearchToolProperties.class, CommandToolProperties.class})
@Configuration(proxyBeanMethods = false)
public class CommonToolConfiguration {

    @Bean
    @ConditionalOnMissingBean(name = "webSearchToolDefinition")
    public ToolDefinition<WebSearchExecutor> webSearchToolDefinition(WebSearchEngine webSearchEngine, WebSearchToolProperties webSearchToolProperties, ObjectMapper objectMapper) {
        String name = "web_search";
        ToolDefinition<WebSearchExecutor> definition = ToolDefinition.<WebSearchExecutor>builder()
                .executor(new WebSearchExecutor(webSearchEngine,objectMapper))
                .id(name)
                .name(name)
                .description("Search the web for external or current information.")
                .parametersJsonSchema(("""
                        {
                          "type": "object",
                          "properties": {
                            "query": {"type": "string", "description": "Search the web for external or current information. it is a required parameter"},
                            "max_results": {"type": "number", "description": "Maximum number of results to return. it is an optional parameter max :%s"},
                            "start_date": {"type": "string", "description": " Will return all results after the specified date until current date. Required to be written in the format YYYY-MM-DD. it is an optional parameter"},
                            "end_date": {"type": "string", "description": " Will return all results before the specified date until current date. Required to be written in the format YYYY-MM-DD. it is an optional parameter"}
                          }
                        }
                        """).formatted(String.valueOf(webSearchToolProperties.getMaxResult())))
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .maxOutput(3_000)
                .timeout(30L)

                .build();
        log.info("注册网页检索工具: toolName=web_search");
        return definition;
    }

    @Bean
    public WebSearchEngine webSearchEngine(WebSearchToolProperties webSearchToolProperties, ObjectMapper objectMapper, WebResultSummarizer webResultSummarizer) {
        return new WebSearchEngine(WebSearchConfig.builder()
                .baseUrl(webSearchToolProperties.getBaseUrl())
                .apiKey(webSearchToolProperties.getApiKey())
                .maxResult(webSearchToolProperties.getMaxResult())
                .timeout(30L)
                .build()
                , HttpClient.newHttpClient()
                , objectMapper
                , webResultSummarizer
        );
    }

    /** 压缩模型直接使用框架提供的 compact 配置。 */
    @Bean
    public ChatModel defaultContextCompactModel(
            ModelProviderRegistry<ChatModel> chatModelProviderRegistry,
            @Qualifier("compactContextModelConfig") ModelConfig config) {
        return chatModelProviderRegistry.create(config);
    }

    @Bean
    public WebResultSummarizer resultSummarizer(@Qualifier("defaultContextCompactModel") ChatModel chatModel){
        return new WebResultSummarizer(chatModel);
    }

}
