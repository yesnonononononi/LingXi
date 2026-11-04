package com.summit.dp.context;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.adapter.langchain4j.codec.tool.ToolCodecAdapter;
import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.anno.Tool;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.runtime.loop.LoopInterceptorProcessor;
import com.summit.runtime.loop.LoopInterceptorFactory;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.ddd.infrastructure.repository.json.AbstractJsonRepository;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.mcp.HostMcpScopeProvider;
import com.summit.dp.workflow.infrastructure.tools.config.ToolDefinitionSchemaGate;
import com.summit.dp.workflow.infrastructure.tools.memory.MemoryWikiLoader;
import com.summit.dp.workflow.infrastructure.tools.memory.MemoryWikiManager;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.SendMailToAgentTool;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentWaitInterceptor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskLoopInterceptor;
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
import java.util.TreeSet;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mockingDetails;

/**
 * 独立验证：真跑一次完整 {@code ApplicationContext} 装配，证明「编译过 → 容器能装」。
 *
 * <p>隔离措施（避免干扰已在 8088 运行的实例与外部依赖）：</p>
 * <ul>
 *   <li>{@code webEnvironment=NONE}：不绑定端口，绝不与运行中的实例抢 8088。</li>
 *   <li>数据源改系统临时目录里的 SQLite 文件库：不去打开实例正在使用的 {@code ~/.lingxi/data/lingxi.sqlite}。</li>
 *   <li>建表交给生产初始化器（ApplicationRunner）跑一遍，顺带验证真实建库脚本能装进容器。</li>
 *   <li>{@code lingxi.data.dir} / 四个 config 路径指向 {@code .run/tmp}，不写用户真实配置。</li>
 *   <li>MCP 使用真实工厂及独立的空配置，验证装配时不连接外部服务。</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {
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

    /** 库建在系统临时目录：不打开实例正在用的库，也不在工作区留文件。 */
    private static final String DATABASE_URL = H2TestDatabase.newDatasourceUrl("ctx-verify");

    @org.springframework.test.context.DynamicPropertySource
    static void datasource(org.springframework.test.context.DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", () -> DATABASE_URL);
        registry.add("spring.datasource.driver-class-name", () -> "org.h2.Driver");
    }

    @Autowired
    private McpClientFactory clientFactory;

    @Autowired
    private ApplicationContext context;

    @Test
    void memoryReaderUsesTheManagedExecutorAndIndependentPrototypeIndexes() {
        ToolDefinition<?> definition = context.getBean(ToolRegistry.class).getTool(ToolCatalog.LOAD_MEMORY);
        assertNotNull(definition);
        assertSame(context.getBean(MemoryWikiLoader.class), definition.executor());
        assertTrue(context.getBean(ToolCatalog.class).readOnlyNames().contains(ToolCatalog.LOAD_MEMORY));
        assertNotSame(context.getBean(MemoryWikiManager.class), context.getBean(MemoryWikiManager.class));
    }

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
        assertTrue(interceptors.containsKey("emailLoopInterceptor"),
                "取信拦截器应同时在列（对照），实际=" + interceptors.keySet());

        // 确认处理器与启动扫描共用工厂，注解注册才会进入实际执行链。
        LoopInterceptorProcessor processor = context.getBean(LoopInterceptorProcessor.class);
        LoopInterceptorFactory factory = context.getBean(LoopInterceptorFactory.class);
        assertSame(factory, ReflectionTestUtils.getField(processor, "loopInterceptorFactory"));
        List<LoopInterceptor> collected = factory.getInterceptors();
        assertTrue(collected.stream().anyMatch(i -> i instanceof SubAgentWaitInterceptor),
                "SubAgentWaitInterceptor 必须被 DefaultLoopInterceptorProcessor 收集，实际=" + collected);
        assertTrue(collected.stream().anyMatch(i -> i instanceof BackgroundTaskLoopInterceptor),
                "后台终端通知拦截器必须进入实际执行链");
        LoopInterceptor memory = factory.get().get("memoryMonitorInterceptor");
        assertNotNull(memory, "记忆容量提醒必须由注解扫描注册到共享工厂");
        assertEquals(-825, memory.order());
        assertFalse(memory.catchErr());
    }

    @Test
    @DisplayName("④ 全量工具 Schema 门禁：装配出来的每个 ToolDefinition 都能被 Jackson 解析并转换成框架工具")
    void everyAssembledToolDefinitionHasUsableSchema() {
        // 门禁 bean 必须真实存在：否则这条断言只剩「我自己也解析了一遍」，挡不住启动期漏检。
        assertEquals(1, context.getBeansOfType(ToolDefinitionSchemaGate.class).size(),
                "启动期 Schema 门禁必须装配且唯一");

        Map<String, ToolDefinition<? extends ToolExecutor>> definitions = context.getBean(ToolRegistry.class).getTools();
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

        assertTrue(names.containsAll(List.of(ToolCatalog.EXECUTE_COMMAND, ToolCatalog.MANAGE_COMMAND,
                        ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE, ToolCatalog.READ_IMAGE, ToolCatalog.GENERATE_IMAGE,
                        ToolCatalog.LOAD_MEMORY, ToolCatalog.SEARCH_WIKI, ToolCatalog.WEB_SEARCH, ToolCatalog.REQUIRE_CHOICE,
                        ToolCatalog.CALL_SUB_AGENT, ToolCatalog.PEEK_TEAMMATE_STATE, ToolCatalog.SEND_MAIL_TO_AGENT,
                        ToolCatalog.CREATE_PLAN,
                        ToolCatalog.CREATE_CHECKLIST, ToolCatalog.GET_CURRENT_CHECKLIST, ToolCatalog.GET_CHECKLIST,
                        ToolCatalog.UPDATE_CHECKLIST_STEP, ToolCatalog.MODIFY_CHECKLIST, ToolCatalog.DELETE_CHECKLIST)),
                "门禁必须覆盖全部基础工具，实际=" + names);

        // 注解工具的「精确集合」白名单：名字取自 ToolCatalog 常量（编译期即可发现改名/删除），
        // 数量由白名单自身推导，不再写裸数字 18/19——新增一个 @Tool 执行器时，
        // 这条断言会立刻指出来「你加的工具没进白名单」，而不是只报一句 expected:<19> but was:<20>。
        // 清单分三组，与 @Tool 的实际落点一一对应：
        //   基础工具 11 件（含 generate_image）、执行清单 6 件、项目记忆 2 件（load_memory / search_wiki），合计 19。
        // 注：web_search 不在其中——它是配置驱动的 ToolDefinition Bean，不是注解工具。
        Set<String> expectedAnnotationTools = Set.of(ToolCatalog.EXECUTE_COMMAND, ToolCatalog.MANAGE_COMMAND,
                ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE, ToolCatalog.READ_IMAGE, ToolCatalog.GENERATE_IMAGE,
                ToolCatalog.LOAD_MEMORY, ToolCatalog.SEARCH_WIKI, ToolCatalog.REQUIRE_CHOICE,
                ToolCatalog.CALL_SUB_AGENT, ToolCatalog.PEEK_TEAMMATE_STATE, ToolCatalog.SEND_MAIL_TO_AGENT,
                ToolCatalog.CREATE_PLAN,
                ToolCatalog.CREATE_CHECKLIST, ToolCatalog.GET_CURRENT_CHECKLIST, ToolCatalog.GET_CHECKLIST,
                ToolCatalog.UPDATE_CHECKLIST_STEP, ToolCatalog.MODIFY_CHECKLIST, ToolCatalog.DELETE_CHECKLIST);
        Set<String> annotationTools = new TreeSet<>();
        definitions.forEach((beanName, definition) -> {
            if (definition.executor().getClass().isAnnotationPresent(Tool.class)) {
                annotationTools.add(definition.name());
            }
        });
        assertEquals(expectedAnnotationTools, annotationTools,
                "注解工具的集合必须与白名单精确一致（多一件=新工具忘了登记；少一件=@Tool 丢了）。"
                        + "白名单在 ApplicationContextAssemblyTest 里，按 ToolCatalog 常量维护。"
                        + "白名单=" + new TreeSet<>(expectedAnnotationTools) + "，实际=" + annotationTools);
        assertEquals(expectedAnnotationTools.size(), annotationTools.size(),
                "数量由白名单推导，白名单自身必须无重复：" + expectedAnnotationTools.size());
        assertEquals(5, context.getBeansOfType(ToolDefinition.class).size(),
                "只有配置驱动的网页检索与四个框架内核工具保留定义 Bean");
        definitions.values().stream()
                .filter(definition -> definition.executor().getClass().isAnnotationPresent(Tool.class))
                .forEach(definition -> assertTrue(context.getBeansOfType(ToolExecutor.class).values().stream()
                                .anyMatch(executor -> executor == definition.executor()),
                        "注解工具必须绑定容器管理的执行器: " + definition.name()));
    }

    @Test
    @DisplayName("③ 无循环依赖：整图刷新成功即证明 SendMailToAgentTool/ToolConfig → ExecutionResumeCoordinator 这条新边不成环")
    void fullContextLoadsWithoutCircularDependency() {
        // 能走到这里，说明 ApplicationContext 已完全 refresh 成功（含构造成环检测）。
        assertNotNull(context.getBean(LoopInterceptorProcessor.class));
        assertNotNull(context.getBean(SendMailToAgentTool.class));
    }
}
