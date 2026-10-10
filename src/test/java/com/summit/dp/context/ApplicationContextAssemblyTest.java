package com.summit.dp.context;

import com.summit.core.runtime.loop.LoopInterceptor;
import com.summit.core.runtime.loop.LoopInterceptorProcessor;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.tools.baseTools.sub_agent.communication.SendMailToAgentTool;
import com.summit.dp.tools.baseTools.sub_agent.delegation.SubAgentWaitInterceptor;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 独立验证：真跑一次完整 {@code ApplicationContext} 装配，证明「编译过 → 容器能装」。
 *
 * <p>隔离措施（避免干扰已在 8088 运行的实例与外部依赖）：</p>
 * <ul>
 *   <li>{@code webEnvironment=NONE}：不绑定端口，绝不与运行中的实例抢 8088。</li>
 *   <li>数据源改内存 H2：不去打开实例正在使用的 {@code ~/.lingxi/data/lingxi.mv.db} 文件库。</li>
 *   <li>{@code lingxi.data.dir} / 三个 config 路径指向 {@code .run/tmp}，不写用户真实配置。</li>
 *   <li>MCP 关闭、API Key 置为占位符值，避免联网与未解析占位符导致的环境噪声。</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.NONE, properties = {
        "spring.datasource.url=jdbc:h2:mem:ctxverify;MODE=MySQL;DB_CLOSE_DELAY=-1",
        "lingxi.data.dir=D:/Code/LingXi/.run/tmp/ctx-verify/data",
        "lingxi.skill.dir=",
        "lingxi.mcp.enabled=false",
        "lingxi.config.user-configs.path=D:/Code/LingXi/.run/tmp/ctx-verify/user-configs.yaml",
        "lingxi.config.mcp.path=D:/Code/LingXi/.run/tmp/ctx-verify/mcp.yaml",
        "lingxi.config.model.path=D:/Code/LingXi/.run/tmp/ctx-verify/models.yaml",
        "TAVILY_APIKEY=ctx-verify-placeholder",
        "DEEPSEEK_APIKEY=ctx-verify-placeholder"
})
class ApplicationContextAssemblyTest {

    @Autowired
    private ApplicationContext context;

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
    }

    @Test
    @DisplayName("③ 无循环依赖：整图刷新成功即证明 SendMailToAgentTool/ToolConfig → ExecutionResumeCoordinator 这条新边不成环")
    void fullContextLoadsWithoutCircularDependency() {
        // 能走到这里，说明 ApplicationContext 已完全 refresh 成功（含构造成环检测）。
        assertNotNull(context.getBean(LoopInterceptorProcessor.class));
        assertNotNull(context.getBean(SendMailToAgentTool.class));
    }
}
