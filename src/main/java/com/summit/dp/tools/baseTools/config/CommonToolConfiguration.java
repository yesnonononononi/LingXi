package com.summit.dp.tools.baseTools.config;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.summit.dp.tools.baseTools.config.properties.WebSearchToolProperties;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.interceptor.InterceptorProcessor;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.tool.*;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.tools.baseTools.web.WebResultSummarizer;
import com.summit.dp.tools.baseTools.web.WebSearchConfig;
import com.summit.dp.tools.baseTools.web.WebSearchEngine;
import com.summit.dp.tools.baseTools.web.WebSearchExecutor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

import java.net.http.HttpClient;

/**
 * 基础工具的装配入口。
 *
 * <p>这些工具不再有 yaml {@code enabled} 开关。装配由代码决定，不由某个部署恰好写没写一个键决定；
 * 要停用某个工具，从 Agent 的工具清单里去掉它即可（框架侧名单即授权）。保留的 yaml 键只剩工具真正
 * 需要的连接参数（web-search 的 baseUrl / apiKey / maxResult）。</p>
 */
@Slf4j
@EnableConfigurationProperties(WebSearchToolProperties.class)
@org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
public class CommonToolConfiguration {
    @Bean
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
                .timeout(120L)
                .build();
    }

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
     * 工具检索入口（{@code search_tool}）已归框架侧：{@code harness-kernel-tools} 模块的
     * {@code SearchToolAutoConfiguration} 默认注册，应用侧不再重复声明——重复声明只会让
     * 「哪个实现生效」取决于装配顺序。
     *
     * <p>要替换实现时，在本类声明同名 {@code searchToolDefinition} bean 即可，框架的
     * {@code @ConditionalOnMissingBean} 会让位；工具名必须保持
     * {@link com.summit.kernel.tools.search.SearchToolExecutor#NAME}，因为系统提示词与框架的披露账本
     * 都按这个名字引用它。</p>
     */

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
