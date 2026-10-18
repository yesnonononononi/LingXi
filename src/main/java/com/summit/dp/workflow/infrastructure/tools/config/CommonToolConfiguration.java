package com.summit.dp.workflow.infrastructure.tools.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;

import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import com.summit.dp.workflow.infrastructure.tools.config.properties.WebSearchToolProperties;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.interceptor.InterceptorProcessor;
import com.summit.core.model.ModelProviderRegistry;
import com.summit.core.model.chat.ChatModel;
import com.summit.core.tool.*;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcesser;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcessManager;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.ManageCommandToolExecutor;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.web.WebResultSummarizer;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchConfig;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchEngine;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchExecutor;
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
 * 要停用某个工具，从 Agent 的工具清单里去掉它即可（框架侧名单即授权）。yaml 只配置工具的连接参数与执行限制。</p>
 */
@Slf4j
@EnableConfigurationProperties({WebSearchToolProperties.class, CommandToolProperties.class})
@org.springframework.context.annotation.Configuration(proxyBeanMethods = false)
public class CommonToolConfiguration {
    @Bean
    @ConditionalOnMissingBean(name = "executeCommandToolDefinition")
    public ToolDefinition<CommandToolDefinitionExecutor> executeCommandToolDefinition(ObjectMapper objectMapper, TerminalSecurityPolicy security, BackendProcesser background, CommandToolProperties properties) {
        String name = ToolCatalog.EXECUTE_COMMAND;
        // SERIAL_MUTATION：终端命令一律串行，不参与并发窗口。
        // 框架判据是「整批请求全都 allowConcurrent 才并发」（DefaultToolExecutionManager#canExecuteConcurrently），
        // 故模型在同一轮里发起的多条命令会在同一线程上顺序执行，不会互相抢占工作区。
        return ToolDefinition.<CommandToolDefinitionExecutor>builder()
                .executor(new CommandToolDefinitionExecutor(objectMapper, security, background, properties))
                .id(name)
                .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION)
                .name(name)
                .description("""
                        Execute a terminal command in the assigned workspace environment.
                        Output may be truncated according to the configured maximum.
                        Set background=true to return a persisted taskId immediately. Completion is reported to this execution automatically; use manage_command to inspect or stop tasks.
                        Always state in `intention` what the command is for; it is displayed to the user.
                        """)
                .parametersJsonSchema("""
                        {
                          "type": "object",
                          "properties": {
                            "command": {"type": "string", "description": "Raw command text using the shell reported by the assigned workspace. The workspace selects and starts the shell automatically; do not add a shell launcher prefix or probe other shells."},
                            "intention": {"type": "string", "description": "One short sentence stating what this command is intended to achieve. It is shown to the user in the UI next to the command, so make it specific and human-readable."},
                            "background": {"type": "boolean", "default": false, "description": "Return a taskId immediately while the command runs in the background. Completion is injected into this execution automatically, so continue other work without polling. Natural completion waits for this execution's tasks. The configured background timeout and the same output limit apply."}
                          },
                          "required": ["command", "intention"]
                        }
                        """)
                .maxOutput(5_000)
                .timeout(240L)
                .build();
    }

    @Bean
    @ConditionalOnMissingBean(name = "manageCommandToolDefinition")
    public ToolDefinition<ManageCommandToolExecutor> manageCommandToolDefinition(ObjectMapper mapper, BackendProcessManager manager) {
        return ToolDefinition.<ManageCommandToolExecutor>builder()
                .id(ToolCatalog.MANAGE_COMMAND).name(ToolCatalog.MANAGE_COMMAND)
                .executor(new ManageCommandToolExecutor(mapper, manager))
                .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION)
                .description("Manage background commands in the current session. List returns task summaries. Snapshot returns current output immediately. Read waits for completion up to the tool timeout and returns the final status, output and exit code; interrupting the wait does not stop the task. Stop waits for confirmed termination.")
                .parametersJsonSchema("""
                        {"type":"object","properties":{
                          "action":{"type":"string","enum":["list","read","stop","snapshot"]},
                          "taskId":{"type":"string","description":"Exact taskId returned by execute_command; required for read, snapshot and stop."}
                        },"required":["action"]}
                        """)
                .timeout(30L).maxOutput(55_000).build();
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
