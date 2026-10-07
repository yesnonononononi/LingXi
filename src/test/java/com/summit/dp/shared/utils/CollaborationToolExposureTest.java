package com.summit.dp.shared.utils;

import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.McpTransport;
import com.summit.core.conf.ModelConfig;
import com.summit.dp.agent.application.service.AgentService;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.shared.settings.SettingsProvider;
import com.summit.dp.shared.skill.SkillRootResolver;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 请求级工具清单的授权边界回归。
 *
 * <p>两条独立约束，此前容易互相干扰，这里分别锁住：</p>
 * <ol>
 *   <li><b>框架语义：名单即授权。</b>未配清单不再等于「不加限制」—— 不显式写出来的静态工具
 *       一律不暴露。这消除了「清单组装失败变成 null，静默放大为进程内全部能力」的隐患。</li>
 *   <li><b>业务语义：MCP 在场则兜底检索入口。</b>请求级 MCP 工具名无法预先进清单，模型只能靠
 *       {@code search_tool} 发现它们；框架侧对 MCP 工具一律放行，所以「看得见就能执行」。</li>
 * </ol>
 *
 * <p>另一组回归：{@code call_sub_agent} 与 {@code send_mail_to_agent} 只在身份前置条件满足时
 * 才允许出现在模型可见清单里。真实故障背景（本地库 execution 快照已核实）：裸模型会话既没有
 * {@code lingxi.agent_id} 也没有 {@code lingxi.team_id}，却因「未配工具清单 = 不加限制」拿到全部
 * 已注册工具，模型于是调用这两个工具、收到「未确定当前协作团队」/「当前执行未绑定 Agent」。</p>
 */
class CollaborationToolExposureTest {

    private static final Set<String> REGISTERED = Set.of(
            ToolCatalog.CALL_SUB_AGENT, ToolCatalog.SEND_MAIL_TO_AGENT, ToolCatalog.CREATE_PLAN,
            "read_file", "edit_file", "execute_command", "web_search", "require_choice");

    // --- 授权边界：名单即授权 ------------------------------------------------------------

    @Test
    @DisplayName("未配清单且无 MCP：不暴露任何静态工具，而不是「不加限制」")
    void absentWhitelistGrantsNoStaticTool() {
        AgentRequest request = request(null, null, null);

        assertEquals(List.of(), request.getToolList(),
                "未显式授权就不该有工具；返回 null 会静默放大为进程内全部能力");
    }

    @Test
    @DisplayName("未配清单但配了 MCP：兜底两级检索入口，静态工具仍不暴露")
    void mcpPresenceFallsBackToTheSearchEntry() {
        AgentRequest request = request(null, null, null, REGISTERED, true);

        assertEquals(List.of(ToolCatalog.LIST_MCP_TOOLS, ToolCatalog.SEARCH_TOOL), request.getToolList(),
                "MCP 工具分两级发现：先列清单（不含 schema）再检索（含 schema）；静态工具仍须显式授权");
    }

    @Test
    @DisplayName("MCP 配置为空：等同于没有 MCP，不兜底检索入口")
    void emptyMcpConfigIsNotPresence() {
        AgentRequest request = request(null, null, null, REGISTERED, false);

        assertEquals(List.of(), request.getToolList(),
                "空 mcpConfig 与无 mcpConfig 一视同仁，不该凭空塞一个检索工具");
    }

    @Test
    @DisplayName("配了静态工具清单：按清单走，并补上两级 MCP 入口")
    void explicitWhitelistIsHonouredAndCarriesSearchEntry() {
        AgentRequest request = request(null, null,
                List.of("read_file", "edit_file"), REGISTERED, true);

        assertEquals(List.of("read_file", "edit_file", ToolCatalog.LIST_MCP_TOOLS, ToolCatalog.SEARCH_TOOL),
                request.getToolList());
    }

    @Test
    @DisplayName("配了静态工具清单但无 MCP：不补检索入口，严格等于所配内容")
    void explicitWhitelistWithoutMcpStaysExact() {
        AgentRequest request = request(null, null,
                List.of("read_file", "edit_file"), REGISTERED, false);

        assertEquals(List.of("read_file", "edit_file"), request.getToolList());
    }

    // --- 默认档位：基础工具集 --------------------------------------------------------------

    @Test
    @DisplayName("默认 Agent（无团队无 Agent）：拿到基础工具集，且不含任何协作工具")
    void defaultAgentGetsTheBasicTools() {
        AgentRequest request = request(null, null, ToolCatalog.DEFAULT_AGENT_TOOLS, REGISTERED, true);

        assertEquals(List.of("execute_command", "read_file", "edit_file", "web_search",
                        ToolCatalog.LIST_MCP_TOOLS, ToolCatalog.SEARCH_TOOL),
                request.getToolList(),
                "终端 + 文件读写 + 联网检索，外加两级 MCP 发现入口；协作工具不该出现（这里给了也调不动）");
    }

    @Test
    @DisplayName("默认 Agent 无 MCP：基础工具集原样，不凭空多出检索入口")
    void defaultAgentWithoutMcpGetsExactlyTheBasicTools() {
        AgentRequest request = request(null, null, ToolCatalog.DEFAULT_AGENT_TOOLS, REGISTERED, false);

        assertEquals(List.of("execute_command", "read_file", "edit_file", "web_search"),
                request.getToolList());
    }

    @Test
    @DisplayName("只读档位：基础工具集自动收敛成只读的那一半")
    void readOnlyModeTrimsTheBasicToolsToTheirReadOnlyHalf() {
        AgentRequest request = request(null, null, ToolCatalog.DEFAULT_AGENT_TOOLS, REGISTERED, false,
                AgentAccessMode.READ_ONLY_IN_WORKSPACE, Set.of("read_file", "web_search"));

        assertEquals(List.of("read_file", "web_search"), request.getToolList(),
                "写工具（execute_command / edit_file）被只读滤网剔除，其余原样保留");
    }

    // --- 身份剔除：模型看不到它用不了的能力 ----------------------------------------------

    @Test
    @DisplayName("裸模型（无 Agent、无团队）：显式授权两个协作工具也会被剔除")
    void bareModelGetsNoCollaborationTools() {
        AgentRequest request = request(null, null,
                List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.SEND_MAIL_TO_AGENT, "read_file"));

        List<String> tools = request.getToolList();
        assertNotNull(tools);
        assertFalse(tools.contains(ToolCatalog.CALL_SUB_AGENT), "没有团队就没有可委派对象");
        assertFalse(tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT), "没有 Agent 就没有发件人");
        assertTrue(tools.contains("read_file"), "其余工具不受影响");
    }

    @Test
    @DisplayName("单 Agent 直聊（有 Agent、无团队）：保留发信，剔除委派")
    void singleAgentKeepsMailButNotDelegation() {
        AgentRequest request = request(5L, null,
                List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.SEND_MAIL_TO_AGENT));

        List<String> tools = request.getToolList();
        assertNotNull(tools);
        assertTrue(tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT),
                "发件人身份来自当前执行，已绑定 Agent 即可发信");
        assertFalse(tools.contains(ToolCatalog.CALL_SUB_AGENT), "委派只在团队里成立");
    }

    @Test
    @DisplayName("团队指挥者（Agent + 团队）：两个协作工具都保留")
    void teamCommanderKeepsBoth() {
        AgentRequest request = request(7L, 3L,
                List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.SEND_MAIL_TO_AGENT));

        List<String> tools = request.getToolList();
        assertNotNull(tools);
        assertTrue(tools.contains(ToolCatalog.CALL_SUB_AGENT));
        assertTrue(tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT));
    }

    // --- Skill：提示词说了，工具就必须给 ---------------------------------------------------

    @TempDir
    Path skillDir;

    @Test
    @DisplayName("Skill 根目录可用：补 read_skill 并下发 skillConfig")
    void skillRootAddsReadSkillAndConfig() {
        AgentRequest request = request(null, null, List.of("read_file"), REGISTERED, false,
                AgentAccessMode.IN_WORKSPACE, Set.of(), new SkillRootResolver(skillDir.toString()));

        assertEquals(List.of("read_file", ToolCatalog.READ_SKILL), request.getToolList(),
                "框架渲染的 Skill 提示词只给名称与入口路径，读正文全靠 read_skill；名单即授权，必须在这里补");
        assertNotNull(request.getSkillConfig(), "必须下发 skillConfig，否则框架压根不会渲染 Skill 提示词");
        assertEquals(skillDir.toAbsolutePath().normalize(), request.getSkillConfig().getPath(),
                "skillConfig 必须指向配置的根目录，框架按它递归找 SKILL.md");
    }

    @Test
    @DisplayName("Skill 可用 + 只读档位：read_skill 必须通过只读滤网（登记为 READ_ONLY）")
    void skillRootToolSurvivesTheReadOnlyFilter() {
        AgentRequest request = request(null, null, List.of("read_file", "edit_file"), REGISTERED, false,
                AgentAccessMode.READ_ONLY_IN_WORKSPACE, Set.of("read_file", ToolCatalog.READ_SKILL),
                new SkillRootResolver(skillDir.toString()));

        assertEquals(List.of("read_file", ToolCatalog.READ_SKILL), request.getToolList(),
                "补入位置必须在只读滤网之前：滤网只剔写工具，读技能是只读动作，不该被剔掉");
    }

    @Test
    @DisplayName("Skill 关闭（目录不可用）：不补 read_skill、不下发 skillConfig")
    void absentSkillRootAddsNothing() {
        AgentRequest request = request(null, null, List.of("read_file"));

        assertEquals(List.of("read_file"), request.getToolList(),
                "目录不可用时不下发：框架把「配了目录却不存在」判为错误，不能凭空造一个");
        assertNull(request.getSkillConfig());
    }

    // --- helpers -------------------------------------------------------------------------

    private AgentRequest request(Long agentId, Long teamId, List<String> configuredTools) {
        return request(agentId, teamId, configuredTools, REGISTERED, false);
    }

    private AgentRequest request(Long agentId, Long teamId, List<String> configuredTools,
                                 Set<String> registered, boolean withMcp) {
        return request(agentId, teamId, configuredTools, registered, withMcp,
                AgentAccessMode.IN_WORKSPACE, Set.of());
    }

    private AgentRequest request(Long agentId, Long teamId, List<String> configuredTools,
                                 Set<String> registered, boolean withMcp,
                                 AgentAccessMode mode, Set<String> readOnlyNames) {
        return request(agentId, teamId, configuredTools, registered, withMcp, mode, readOnlyNames,
                new SkillRootResolver(""));
    }

    private AgentRequest request(Long agentId, Long teamId, List<String> configuredTools,
                                 Set<String> registered, boolean withMcp,
                                 AgentAccessMode mode, Set<String> readOnlyNames,
                                 SkillRootResolver skillRootResolver) {
        ToolCatalog catalog = mock(ToolCatalog.class);
        when(catalog.names()).thenReturn(registered);
        when(catalog.readOnlyNames()).thenReturn(readOnlyNames);
        McpService mcpService = mock(McpService.class);
        when(mcpService.currentConfig()).thenReturn(mcpConfig(withMcp));

        RequestPreparer preparer = new RequestPreparer(mock(SessionService.class),
                mock(com.summit.dp.session.domain.repo.SessionRepository.class),
                mock(WorkspaceService.class), mock(ModelService.class), mock(WorkspaceConverter.class),
                mock(SettingsProvider.class), catalog, mock(ConversationTranscriptService.class),
                mock(ModelContextService.class),                 mock(ExecutionIdentity.class),
                mock(com.summit.dp.turn.application.service.ChatTurnService.class),
                mock(AgentService.class), mock(TeamService.class), mcpService, skillRootResolver);

        // executionId 必须非空：buildRequest 不再自造身份，缺身份即视为「prepare 没跑」并直接报错。
        ExecutionContext executionContext = ExecutionContext.root(500L, "2105000000000000001", null, null,
                mode, CommandApprovalPolicy.FULL_ACCESS);
        RuntimeContext context = new RuntimeContext(executionContext, agentId, teamId,
                SessionVO.builder().id(500L).build(), List.of(), null,
                ModelConfig.builder().baseUrl("https://example.invalid").apiKey("k").modelName("m").build(),
                mode, CommandApprovalPolicy.FULL_ACCESS, false, null);

        return preparer.buildRequest("prompt", context, configuredTools);
    }

    private static McpConfig mcpConfig(boolean present) {
        McpConfig config = new McpConfig();
        if (!present) {
            // 空配置与无配置都必须被当作「没有 MCP」。
            config.setMcp(List.of());
            return config;
        }
        config.setMcp(List.of(new McpConfig.MCP("test-server", "测试服务", McpTransport.STREAMABLE_HTTP,
                new McpConfig.StreamableHttp("https://example.invalid/mcp", Map.of(), null, null), 1000)));
        return config;
    }
}
