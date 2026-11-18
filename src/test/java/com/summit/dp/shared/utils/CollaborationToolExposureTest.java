package com.summit.dp.shared.utils;

import com.summit.core.agent.AgentRequest;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.McpTransport;
import com.summit.core.conf.ModelConfig;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.RuntimeConfigurationTestSupport;
import com.summit.dp.mcp.application.service.McpService;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.tools.application.service.ToolListProcessor;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.application.chat.ExecutionContext;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.RequestPreparerTestSupport;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 请求级工具清单的授权边界回归。
 *
 * <p>两条独立约束，此前容易互相干扰，这里分别锁住：</p>
 * <ol>
 *   <li><b>框架语义：名单即授权。</b>未配清单不再等于「不加限制」—— 不显式写出来的静态工具
 *       一律不暴露。这消除了「清单组装失败变成 null，静默放大为进程内全部能力」的隐患。</li>
 *   <li><b>内核工具不进名单。</b>{@code search_tool} / {@code list_mcp_tools} /
 *       {@code call_mcp_tool} / {@code read_skill} / {@code compact_context} 由框架默认注册并
 *       恒准入，业务侧既不补也不滤：它们换名字、换口径都由框架一个地方决定。</li>
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
            "read_file", "search_files", "edit_file", "delete_file", "execute_command", "require_choice");

    // --- 授权边界：名单即授权 ------------------------------------------------------------

    @Test
    void imageToolFollowsTheVisionDeclarationRatherThanTheName() {
        AgentRequest supported = request(null, null, List.of(ToolCatalog.READ_FILE, ToolCatalog.READ_IMAGE),
                REGISTERED, false, AgentPermissionMode.APPROVAL_REQUIRED, Set.of(), new SkillRootResolver(""), "arbitrary-model", true);
        assertTrue(supported.getToolSpec().getToolList().contains(ToolCatalog.READ_IMAGE));
        assertEquals(true, supported.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.MODEL_VISION));

        AgentRequest unsupported = request(null, null, List.of(ToolCatalog.READ_FILE, ToolCatalog.READ_IMAGE),
                REGISTERED, false, AgentPermissionMode.APPROVAL_REQUIRED, Set.of(), new SkillRootResolver(""), "claude-opus", false);
        assertEquals(List.of(ToolCatalog.READ_FILE), unsupported.getToolSpec().getToolList());
        assertEquals(false, unsupported.runtimeParametersOrDefault().getAttributes().get(ExecutionAttributes.MODEL_VISION));

        AgentRequest explicitlySelected = request(7L, null, List.of(ToolCatalog.READ_FILE),
                REGISTERED, false, AgentPermissionMode.APPROVAL_REQUIRED, Set.of(), new SkillRootResolver(""), "arbitrary-model", true);
        assertEquals(List.of(ToolCatalog.READ_FILE, ToolCatalog.READ_IMAGE), explicitlySelected.getToolSpec().getToolList());

        AgentRequest readOnly = request(null, null, List.of(ToolCatalog.READ_IMAGE, ToolCatalog.EDIT_FILE),
                REGISTERED, false, AgentPermissionMode.READ_ONLY_REVIEW, Set.of(ToolCatalog.READ_IMAGE),
                new SkillRootResolver(""), "arbitrary-model", true);
        assertEquals(List.of(ToolCatalog.READ_IMAGE, ToolCatalog.EDIT_FILE), readOnly.getToolSpec().getToolList());
        assertEquals(List.of(ToolCatalog.EDIT_FILE), readOnly.getToolSpec().getForbiddenTools());
    }

    @Test
    @DisplayName("未配清单且无 MCP：不暴露任何静态工具，而不是「不加限制」")
    void absentWhitelistGrantsNoStaticTool() {
        AgentRequest request = request(null, null, null);

        assertEquals(List.of(), request.getToolSpec().getToolList(),
                "未显式授权就不该有工具；返回 null 会静默放大为进程内全部能力");
    }

    @Test
    @DisplayName("未配清单但配了 MCP：兜底三级入口，静态工具仍不暴露")
    void mcpPresenceFallsBackToTheMcpEntries() {
        AgentRequest request = request(null, null, null, REGISTERED, true);

        assertEquals(List.of(), request.getToolSpec().getToolList(),
                "内核工具不再由业务侧补：框架默认注册且恒准入；静态工具仍须显式授权");
    }

    @Test
    @DisplayName("MCP 配置为空：等同于没有 MCP，不兜底检索入口")
    void emptyMcpConfigIsNotPresence() {
        AgentRequest request = request(null, null, null, REGISTERED, false);

        assertEquals(List.of(), request.getToolSpec().getToolList(),
                "空 mcpConfig 与无 mcpConfig 一视同仁，不该凭空塞一个检索工具");
    }

    @Test
    @DisplayName("配了静态工具清单：按清单走，并补上三级 MCP 入口")
    void explicitWhitelistIsHonouredAndCarriesTheMcpEntries() {
        AgentRequest request = request(null, null,
                List.of("read_file", "edit_file"), REGISTERED, true);

        assertEquals(List.of("read_file", "edit_file"), request.getToolSpec().getToolList(),
                "内核工具不进名单：框架默认注册且恒准入");
    }

    @Test
    @DisplayName("配了静态工具清单但无 MCP：不补检索入口，严格等于所配内容")
    void explicitWhitelistWithoutMcpStaysExact() {
        AgentRequest request = request(null, null,
                List.of("read_file", "edit_file"), REGISTERED, false);

        assertEquals(List.of("read_file", "edit_file"), request.getToolSpec().getToolList());
    }

    // --- 默认档位：基础工具集 --------------------------------------------------------------

    @Test
    void configuredChecklistWritersAlsoReceiveTheCurrentSessionReader() {
        for (String writer : List.of(ToolCatalog.CREATE_CHECKLIST, ToolCatalog.UPDATE_CHECKLIST_STEP,
                ToolCatalog.MODIFY_CHECKLIST, ToolCatalog.DELETE_CHECKLIST)) {
            AgentRequest request = request(null, null, List.of(writer), REGISTERED, false);
            assertEquals(List.of(writer, ToolCatalog.GET_CURRENT_CHECKLIST), request.getToolSpec().getToolList());
            AgentRequest readOnly = request(null, null, List.of(writer), REGISTERED, false,
                    AgentPermissionMode.READ_ONLY_REVIEW, Set.of(ToolCatalog.GET_CURRENT_CHECKLIST));
            assertEquals(List.of(writer, ToolCatalog.GET_CURRENT_CHECKLIST), readOnly.getToolSpec().getToolList());
            assertEquals(List.of(writer), readOnly.getToolSpec().getForbiddenTools());
        }
    }

    @Test
    @DisplayName("默认 Agent（无团队无 Agent）：拿到基础工具集，且不含任何协作工具")
    void defaultAgentGetsTheBasicTools() {
        AgentRequest request = request(null, null, ToolCatalog.DEFAULT_AGENT_TOOLS, REGISTERED, true);

        assertEquals(List.of(ToolCatalog.EXECUTE_COMMAND, ToolCatalog.MANAGE_COMMAND, ToolCatalog.READ_FILE,
                        ToolCatalog.SEARCH_FILES, ToolCatalog.LOAD_MEMORY, ToolCatalog.SEARCH_WIKI,
                        ToolCatalog.EDIT_FILE, ToolCatalog.WRITE_FILE, ToolCatalog.DELETE_FILE,
                        ToolCatalog.REQUIRE_CHOICE, ToolCatalog.CREATE_PLAN,
                        ToolCatalog.CREATE_CHECKLIST, ToolCatalog.GET_CURRENT_CHECKLIST, ToolCatalog.GET_CHECKLIST,
                        ToolCatalog.UPDATE_CHECKLIST_STEP, ToolCatalog.MODIFY_CHECKLIST, ToolCatalog.DELETE_CHECKLIST),
                request.getToolSpec().getToolList(),
                "基础工具包含用户确认、审批计划、执行清单、文件检索写入删除与项目记忆读取/检索；内核工具不进名单，协作工具不该出现");
    }

    @Test
    @DisplayName("默认 Agent 无 MCP：基础工具集原样，不凭空多出检索入口")
    void defaultAgentWithoutMcpGetsExactlyTheBasicTools() {
        AgentRequest request = request(null, null, ToolCatalog.DEFAULT_AGENT_TOOLS, REGISTERED, false);

        assertEquals(List.of(ToolCatalog.EXECUTE_COMMAND, ToolCatalog.MANAGE_COMMAND, ToolCatalog.READ_FILE,
                        ToolCatalog.SEARCH_FILES, ToolCatalog.LOAD_MEMORY, ToolCatalog.SEARCH_WIKI,
                        ToolCatalog.EDIT_FILE, ToolCatalog.WRITE_FILE, ToolCatalog.DELETE_FILE,
                        ToolCatalog.REQUIRE_CHOICE, ToolCatalog.CREATE_PLAN,
                        ToolCatalog.CREATE_CHECKLIST, ToolCatalog.GET_CURRENT_CHECKLIST, ToolCatalog.GET_CHECKLIST,
                        ToolCatalog.UPDATE_CHECKLIST_STEP, ToolCatalog.MODIFY_CHECKLIST, ToolCatalog.DELETE_CHECKLIST),
                request.getToolSpec().getToolList());
    }

    @Test
    @DisplayName("只读审阅档位：禁用编辑工具和终端工具，保留只读工具")
    void readOnlyModeDisablesEditingAndTerminal() {
        AgentRequest request = request(null, null, ToolCatalog.DEFAULT_AGENT_TOOLS, REGISTERED, false,
                AgentPermissionMode.READ_ONLY_REVIEW, Set.of("read_file", "search_files", "require_choice",
                        ToolCatalog.GET_CURRENT_CHECKLIST, ToolCatalog.GET_CHECKLIST));

        List<String> forbidden = request.getToolSpec().getForbiddenTools();
        assertTrue(request.getToolSpec().getToolList().containsAll(List.of(ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE, ToolCatalog.EXECUTE_COMMAND)),
                "静态 toolList 保持不变以保护前缀缓存");
        assertFalse(forbidden.contains(ToolCatalog.READ_FILE));
        assertTrue(forbidden.containsAll(List.of(ToolCatalog.EXECUTE_COMMAND, ToolCatalog.MANAGE_COMMAND,
                ToolCatalog.EDIT_FILE, ToolCatalog.WRITE_FILE, ToolCatalog.DELETE_FILE)), "只读审阅档通过黑名单禁用写工具与终端工具");
    }

    // --- 身份剔除：模型看不到它用不了的能力 ----------------------------------------------

    @Test
    @DisplayName("裸模型（无 Agent、无团队）：显式授权两个协作工具也会被剔除")
    void bareModelGetsNoCollaborationTools() {
        AgentRequest request = request(null, null,
                List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.SEND_MAIL_TO_AGENT, "read_file"));

        List<String> tools = request.getToolSpec().getToolList();
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

        List<String> tools = request.getToolSpec().getToolList();
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

        List<String> tools = request.getToolSpec().getToolList();
        assertNotNull(tools);
        assertTrue(tools.contains(ToolCatalog.CALL_SUB_AGENT));
        assertTrue(tools.contains(ToolCatalog.SEND_MAIL_TO_AGENT));
    }

    // --- Skill：提示词说了，工具就必须给 ---------------------------------------------------

    @TempDir
    Path skillDir;

    @Test
    @DisplayName("Skill 根目录可用：下发 skillConfig，read_skill 由框架提供")
    void skillRootAddsReadSkillAndConfig() {
        AgentRequest request = request(null, null, List.of("read_file"), REGISTERED, false,
                AgentPermissionMode.APPROVAL_REQUIRED, Set.of(), new SkillRootResolver(skillDir.toString()));

        assertEquals(List.of("read_file"), request.getToolSpec().getToolList(),
                "read_skill 是内核工具，框架默认注册且恒准入，业务侧不再补进名单");
        assertNotNull(request.getSkillConfig(), "必须下发 skillConfig，否则框架压根不会渲染 Skill 提示词");
        assertEquals(skillDir.toAbsolutePath().normalize(), request.getSkillConfig().getPath(),
                "skillConfig 必须指向配置的根目录，框架按它递归找 SKILL.md");
    }

    @Test
    @DisplayName("Skill 可用 + 只读档位：名单不被只读滤网改写，read_skill 依旧由框架准入")
    void skillRootToolSurvivesTheReadOnlyFilter() {
        AgentRequest request = request(null, null, List.of("read_file", "edit_file"), REGISTERED, false,
                AgentPermissionMode.READ_ONLY_REVIEW, Set.of("read_file", ToolCatalog.READ_SKILL),
                new SkillRootResolver(skillDir.toString()));

        assertEquals(List.of("read_file", "edit_file"), request.getToolSpec().getToolList());
        assertEquals(List.of("edit_file"), request.getToolSpec().getForbiddenTools(),
                "只读滤网按注册表将写工具列入黑名单；read_skill 不在名单里，框架侧恒准入且只读");
    }

    @Test
    @DisplayName("Skill 关闭（目录不可用）：不补 read_skill、不下发 skillConfig")
    void absentSkillRootAddsNothing() {
        AgentRequest request = request(null, null, List.of("read_file"));

        assertEquals(List.of("read_file"), request.getToolSpec().getToolList(),
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
                AgentPermissionMode.APPROVAL_REQUIRED, Set.of());
    }

    private AgentRequest request(Long agentId, Long teamId, List<String> configuredTools,
                                 Set<String> registered, boolean withMcp,
                                 AgentPermissionMode mode, Set<String> readOnlyNames) {
        return request(agentId, teamId, configuredTools, registered, withMcp, mode, readOnlyNames,
                new SkillRootResolver(""));
    }

    private AgentRequest request(Long agentId, Long teamId, List<String> configuredTools,
                                 Set<String> registered, boolean withMcp,
                                 AgentPermissionMode mode, Set<String> readOnlyNames,
                                 SkillRootResolver skillRootResolver) {
        return request(agentId, teamId, configuredTools, registered, withMcp, mode, readOnlyNames, skillRootResolver, "m", false);
    }

    private AgentRequest request(Long agentId, Long teamId, List<String> configuredTools,
                                 Set<String> registered, boolean withMcp, AgentPermissionMode mode,
                                 Set<String> readOnlyNames, SkillRootResolver skillRootResolver, String modelName, boolean vision) {
        ToolCatalog catalog = mock(ToolCatalog.class);
        when(catalog.names()).thenReturn(registered);
        when(catalog.readOnlyNames()).thenReturn(readOnlyNames);
        McpService mcpService = mock(McpService.class);
        when(mcpService.currentConfig()).thenReturn(mcpConfig(withMcp));

        RequestPreparer preparer = RequestPreparerTestSupport.builder()
                .toolListProcessor(new ToolListProcessor(catalog))
                .mcpService(mcpService)
                .skillRootResolver(skillRootResolver)
                .runtimeConfigurations(RuntimeConfigurationTestSupport.create())
                .build();

        // executionId 必须非空：buildRequest 不再自造身份，缺身份即视为「prepare 没跑」并直接报错。
        ExecutionContext executionContext = ExecutionContext.root(500L, "2105000000000000001", null, null,
                mode);
        RuntimeContext context = new RuntimeContext(executionContext, agentId, teamId,
                SessionVO.builder().id(500L).build(), List.of(), null,
                ModelConfig.builder().baseUrl("https://example.invalid").apiKey("k").modelName(modelName).build(),
                mode, false, null, vision);

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
