package com.summit.dp.tools.baseTools.config;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.summit.dp.tools.baseTools.config.properties.TerminalToolProperties;
import com.summit.dp.tools.baseTools.config.properties.WebSearchToolProperties;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.interceptor.InterceptorProcessor;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.tool.*;
import com.summit.dp.tools.baseTools.search.SearchToolExecutor;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.tools.baseTools.web.WebResultSummarizer;
import com.summit.dp.tools.baseTools.web.WebSearchConfig;
import com.summit.dp.tools.baseTools.web.WebSearchEngine;
import com.summit.dp.tools.baseTools.web.WebSearchExecutor;
import com.summit.dp.shared.model.ToolCatalog;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

import java.net.http.HttpClient;

@Slf4j
@EnableConfigurationProperties({WebSearchToolProperties.class, TerminalToolProperties.class})
@org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
public class CommonToolConfiguration {
    @Bean
    @ConditionalOnProperty(
            prefix = "lingxi.agent.runtime.tool.terminal",
            name = "enabled",
            havingValue = "true"
    )
    @ConditionalOnMissingBean(name = "executeCommandToolDefinition")
    public ToolDefinition<CommandToolDefinitionExecutor> executeCommandToolDefinition(ObjectMapper objectMapper) {
        String name = "execute_command";
        return ToolDefinition.<CommandToolDefinitionExecutor>builder()
                .executor(new CommandToolDefinitionExecutor(objectMapper))
                .id(name)
                .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION)
                .name(name)
                .description("""
                        Execute a terminal command in the assigned workspace environment.
                        Output may be truncated according to the configured maximum.
                        """)
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "command": {"type": "string", "description": "require notice system os and use PowerShell if windows. Instruction,example : ll  it is a required parameter"}
                          }
                        }
                        """)
                .maxOutput(5_000)
                .timeout(30L)
                .build();
    }

    @Bean
    @ConditionalOnProperty(
            prefix = "lingxi.agent.runtime.tool.web-search",
            name = "enabled",
            havingValue = "true"
    )
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
                            "maxResults or max_results": {"type": "number", "description": "Maximum number of results to return. it is an optional parameter max :%s"},
                            "startDate or start_date": {"type": "string", "description": " Will return all results after the specified date until current date. Required to be written in the format YYYY-MM-DD. it is an optional parameter"},
                            "endDate or end_date": {"type": "string", "description": " Will return all results before the specified date until current date. Required to be written in the format YYYY-MM-DD. it is an optional parameter"}
                          }
                        }
                        """).formatted(String.valueOf(webSearchToolProperties.getMaxResult())))
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .maxOutput(3_000)
                .timeout(30L)

                .build();
        log.info("webSearchToolDefinition successfully registered");
        return definition;
    }

    @Bean
    @ConditionalOnProperty(
            prefix = "lingxi.agent.runtime.tool.web-search",
            name = "enabled",
            havingValue = "true"
    )
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

    /**
     * 工具检索定义。MCP 工具名在握手前不存在，无法预先进白名单；与其把全部工具塞给模型，
     * 不如给一个「按关键字查本次可调用的工具」的入口。
     *
     * <p>无 {@code @ConditionalOnProperty}：它是请求级 MCP 工具的发现入口，关掉即彻底不可达。</p>
     */
    @Bean
    @ConditionalOnMissingBean(name = "searchToolDefinition")
    public ToolDefinition<SearchToolExecutor> searchToolDefinition(ObjectMapper objectMapper,
                                                                   ObjectProvider<ToolRegistry> toolRegistry) {
        String name = ToolCatalog.SEARCH_TOOL;
        ToolDefinition<SearchToolExecutor> definition = ToolDefinition.<SearchToolExecutor>builder()
                .executor(new SearchToolExecutor(objectMapper, toolRegistry))
                .id(name)
                .name(name)
                .concurrentPolicy(ConcurrentPolicy.READ_ONLY)
                .description("""
                        Search the tools callable in this run and return their names, descriptions and
                        parameter schemas. Use it before calling a tool you have not used yet — remote
                        (MCP) tools in particular are not listed up front. An empty keyword lists everything.
                        """)
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "keyword": {"type": "string", "description": "Fuzzy keyword matched against tool name and description. Optional; omit to list all callable tools."}
                          }
                        }
                        """)
                .maxOutput(4_000)
                .timeout(10L)
                .build();
        log.info("searchToolDefinition successfully registered");
        return definition;
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
