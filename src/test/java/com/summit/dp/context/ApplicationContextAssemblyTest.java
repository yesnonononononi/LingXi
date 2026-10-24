package com.summit.dp.context;

import com.summit.ddd.infrastructure.repository.json.AbstractJsonRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.adapter.langchain4j.codec.tool.ToolCodecAdapter;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.core.runtime.loop.LoopInterceptorProcessor;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.SendMailToAgentTool;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentWaitInterceptor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskLoopInterceptor;
import com.summit.dp.workflow.infrastructure.mcp.HostMcpScopeProvider;
import com.summit.dp.workflow.infrastructure.tools.config.ToolDefinitionSchemaGate;
import com.summit.harness.springbootautoconfigure.config.mcp.McpAutoConfiguration;
import dev.langchain4j.agent.tool.ToolSpecification;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mockingDetails;

/**
 * 独立验证：真跑一次完整 {@code ApplicationContext} 装配，证明「编译过 → 容器能装」。
 *
 * <p>隔离措施（避免干扰已在 8088 运行的实例与外部依赖）：</p>
 * <ul>
 *   <li>{@code webEnvironment=NONE}：不绑定端口，绝不与运行中的实例抢 8088。</li>
 *   <li>数据源改内存 H2：不去打开实例正在使用的 {@code ~/.lingxi/data/lingxi.mv.db} 文件库。</li>
 *   <li>{@code lingxi.data.dir} / 四个 config 路径指向 {@code .run/tmp}，不写用户真实配置。</li>
 *   <li>MCP 使用真实工厂及独立的空配置，验证装配时不连接外部服务。</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {
        "spring.datasource.url=jdbc:h2:mem:ctxverify;MODE=MySQL;DB_CLOSE_DELAY=-1",
        "spring.sql.init.mode=always",
        "spring.sql.init.schema-locations=classpath:init.sql",
        "spring.sql.init.encoding=UTF-8",
        "lingxi.data.dir=D:/Code/LingXi/.run/tmp/ctx-verify/data",
        "lingxi.skill.dir=",
        "lingxi.config.sandbox-security.directory=.run/tmp/ctx-verify/security",
        "lingxi.config.user-configs.path=D:/Code/LingXi/.run/tmp/ctx-verify/user-configs.json",
        "lingxi.config.mcp.path=D:/Code/LingXi/.run/tmp/ctx-verify/mcp.json",
        "lingxi.config.model.path=D:/Code/LingXi/.run/tmp/ctx-verify/models.json",
        "lingxi.config.personalization.path=D:/Code/LingXi/.run/tmp/ctx-verify/personalization.json",
        "TAVILY_APIKEY=ctx-verify-placeholder",
        "DEEPSEEK_APIKEY=ctx-verify-placeholder"
})
class ApplicationContextAssemblyTest {

    @Autowired
    private McpClientFactory clientFactory;

    @Autowired
    private ApplicationContext context;

    @Test
    void realMcpInfrastructureLoadsWithoutTheFrameworkGlobalSwitch() {
        assertNotNull(context.getBean(McpAutoConfiguration.class));
        assertEquals(1, context.getBeansOfType(McpClientFactory.class).size());
        assertFalse(mockingDetails(clientFactory).isMock());
        assertEquals(1, context.getBeansOfType(ScopeMcpProvider.class).size());
        assertTrue(context.getBean(ScopeMcpProvider.class) instanceof HostMcpScopeProvider);
        assertTrue(context.getEnvironment().getProperty("lingxi.mcp.enabled") == null);
    }

    @Test
    void allConfigurationRepositoriesUseJsonStorage() {
        assertEquals(Set.of("modelConfigRepositoryImpl", "providerConfigRepositoryImpl",
                "personalizationRepositoryImpl", "mcpRepositoryImpl", "userConfigRepositoryImpl",
                "securityFilesRepository", "securityTerminalRepository", "securityNetRepository"),
                context.getBeansOfType(AbstractJsonRepository.class).keySet());
        assertTrue(context.getBean("securityFilesRepository") instanceof AbstractJsonRepository);
        assertTrue(context.getBean("securityTerminalRepository") instanceof AbstractJsonRepository);
        assertTrue(context.getBean("securityNetRepository") instanceof AbstractJsonRepository);
    }

    @Test
    @DisplayName("① SendMailToAgentTool 能装配：新增依赖 ExecutionResumeCoordinator 可解析")
    void sendMailToolAndItsNewDependencyAreWired() {
        assertNotNull(context.getBean(SendMailToAgentTool.class),
                "SendMailToAgentTool 必须是可装配的 bean");
        assertNotNull(context.getBean(ExecutionResumeCoordinator.class),
                "新依赖 ExecutionResumeCoordinator 必须可解析（否则 SendMailToAgentTool 装配失败）");
        assertNotNull(context.getBean(EmailService.class));
    }

    @Test
    @DisplayName("② SubAgentWaitInterceptor 在 List<LoopInterceptor> 中，且被处理器实际收集")
    void waitInterceptorIsCollectedIntoLoopInterceptorList() {
        assertNotNull(context.getBean(SubAgentWaitInterceptor.class));

        Map<String, LoopInterceptor> interceptors = context.getBeansOfType(LoopInterceptor.class);
        assertTrue(interceptors.containsKey("subAgentWaitInterceptor"),
                "SubAgentWaitInterceptor 必须出现在 LoopInterceptor 集合里，实际=" + interceptors.keySet());
        assertTrue(interceptors.containsKey("agenticLoopInterceptor"),
                "取信拦截器应同时在列（对照），实际=" + interceptors.keySet());

        // 处理器由框架自动装配；反射读取其内部排序后的列表，决定性证明「收集到了」而非仅「bean 存在」。
        LoopInterceptorProcessor processor = context.getBean(LoopInterceptorProcessor.class);
        @SuppressWarnings("unchecked")
        List<LoopInterceptor> collected =
                (List<LoopInterceptor>) ReflectionTestUtils.getField(processor, "interceptors");
        assertNotNull(collected, "处理器内部拦列表不可为空");
        assertTrue(collected.stream().anyMatch(i -> i instanceof SubAgentWaitInterceptor),
                "SubAgentWaitInterceptor 必须被 DefaultLoopInterceptorProcessor 收集，实际=" + collected);
        assertTrue(collected.stream().anyMatch(i -> i instanceof BackgroundTaskLoopInterceptor),
                "后台终端通知拦截器必须进入实际执行链");
    }

    @Test
    @DisplayName("④ 全量工具 Schema 门禁：装配出来的每个 ToolDefinition 都能被 Jackson 解析并转换成框架工具")
    void everyAssembledToolDefinitionHasUsableSchema() {
        // 门禁 bean 必须真实存在：否则这条断言只剩「我自己也解析了一遍」，挡不住启动期漏检。
        assertEquals(1, context.getBeansOfType(ToolDefinitionSchemaGate.class).size(),
                "启动期 Schema 门禁必须装配且唯一");

        Map<String, ToolDefinition> definitions = context.getBeansOfType(ToolDefinition.class);
        assertTrue(definitions.size() >= 10, "静态装配的工具数量异常，实际=" + definitions.keySet());

        ObjectMapper objectMapper = context.getBean(ObjectMapper.class);
        ToolCodecAdapter codec = new ToolCodecAdapter();
        List<String> names = new ArrayList<>();
        definitions.forEach((beanName, definition) -> {
            assertDoesNotThrow(() -> objectMapper.readTree(definition.parametersJsonSchema()),
                    () -> "工具 " + beanName + " 的参数 Schema 不是合法 JSON");
            ToolSpecification specification = assertDoesNotThrow(() -> codec.toFrameworkTool(definition),
                    () -> "工具 " + beanName + " 无法转换为框架工具定义");
            assertEquals(definition.name(), specification.name());
            names.add(definition.name());
        });

        assertTrue(names.containsAll(List.of("execute_command", "manage_command", "read_file", "edit_file",
                        "read_image", "web_search", "require_choice", "call_sub_agent", "peek_teammate_state",
                        "send_mail_to_agent", "create_plan")),
                "门禁必须覆盖全部基础工具，实际=" + names);
    }

    @Test
    @DisplayName("③ 无循环依赖：整图刷新成功即证明 SendMailToAgentTool/ToolConfig → ExecutionResumeCoordinator 这条新边不成环")
    void fullContextLoadsWithoutCircularDependency() {
        // 能走到这里，说明 ApplicationContext 已完全 refresh 成功（含构造成环检测）。
        assertNotNull(context.getBean(LoopInterceptorProcessor.class));
        assertNotNull(context.getBean(SendMailToAgentTool.class));
    }
}
