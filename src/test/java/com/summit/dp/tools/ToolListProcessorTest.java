package com.summit.dp.tools;

import com.summit.core.conf.McpConfig;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.tools.application.service.ToolListProcessor;
import com.summit.dp.tools.application.service.ToolProcessingContext;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ToolListProcessorTest {
    private final ToolCatalog catalog = mock(ToolCatalog.class);
    private final ToolListProcessor processor = new ToolListProcessor(catalog);

    @Test
    void imageGenerationIsGlobalButStillRespectsReadOnlyAccess() {
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.READ_FILE));
        assertTrue(processor.process(null, ToolProcessingContext.builder().imageGeneration(true)
                .permissionMode(AgentPermissionMode.APPROVAL_REQUIRED).build()).contains(ToolCatalog.GENERATE_IMAGE));
        assertFalse(processor.process(null, ToolProcessingContext.builder().imageGeneration(true)
                .permissionMode(AgentPermissionMode.READ_ONLY_REVIEW).build()).contains(ToolCatalog.GENERATE_IMAGE));
        assertFalse(processor.process(List.of(ToolCatalog.GENERATE_IMAGE), root()).contains(ToolCatalog.GENERATE_IMAGE));
    }

    @Test
    void onlyTheDefaultAgentReceivesTheDefaultTools() {
        ToolProcessingContext context = ToolProcessingContext.builder().defaultAgent(true).permissionMode(AgentPermissionMode.APPROVAL_REQUIRED).build();
        List<String> tools = processor.process(null, context);
        assertTrue(tools.contains(ToolCatalog.READ_FILE));
        assertTrue(tools.contains(ToolCatalog.LOAD_MEMORY));
        assertTrue(tools.contains(ToolCatalog.REQUIRE_CHOICE));
        assertTrue(tools.contains(ToolCatalog.MANAGE_COMMAND));
        assertFalse(tools.contains(ToolCatalog.READ_IMAGE));
        assertFalse(tools.contains(ToolCatalog.CALL_SUB_AGENT));
        assertEquals(List.of(), processor.process(null, root()));
    }

    @Test
    void readOnlyDefaultAgentsKeepTheMemoryReader() {
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.LOAD_MEMORY));
        ToolProcessingContext context = ToolProcessingContext.builder().defaultAgent(true)
                .permissionMode(AgentPermissionMode.READ_ONLY_REVIEW).build();
        assertTrue(processor.process(null, context).contains(ToolCatalog.LOAD_MEMORY));
    }

    @Test
    void projectAgentsReceiveBothWikiToolsIncludingInReadOnlyMode() {
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.LOAD_MEMORY, ToolCatalog.SEARCH_WIKI));
        ToolProcessingContext context = ToolProcessingContext.builder().projectMemory(true)
                .permissionMode(AgentPermissionMode.READ_ONLY_REVIEW).build();
        assertEquals(List.of(ToolCatalog.LOAD_MEMORY, ToolCatalog.SEARCH_WIKI), processor.process(null, context));
    }

    @Test
    void visionAddsTheImageToolAndDisabledVisionRemovesEvenExplicitSelection() {
        assertEquals(List.of(ToolCatalog.READ_FILE, ToolCatalog.READ_IMAGE), processor.process(List.of(ToolCatalog.READ_FILE),
                ToolProcessingContext.builder().vision(true).permissionMode(AgentPermissionMode.APPROVAL_REQUIRED).build()));
        assertEquals(List.of(ToolCatalog.READ_FILE), processor.process(List.of(ToolCatalog.READ_FILE, ToolCatalog.READ_IMAGE), root()));
    }

    @Test
    void nullAndEmptyListsDoNotGrantRegisteredToolsAndInputOrderIsStable() {
        when(catalog.names()).thenReturn(Set.of(ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE));
        assertEquals(List.of(), processor.process(null, root()));
        assertEquals(List.of(), processor.process(List.of(), root()));
        assertEquals(List.of(ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE), processor.process(
                Arrays.asList(null, " ", " read_file ", ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE), root()));
    }

    @Test
    void commandersAndMembersReceiveDifferentCollaborationTools() {
        ToolProcessingContext commander = ToolProcessingContext.builder().agentId(7L).teamId(9L)
                .permissionMode(AgentPermissionMode.APPROVAL_REQUIRED).build();
        assertEquals(List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.PEEK_TEAMMATE_STATE, ToolCatalog.SEND_MAIL_TO_AGENT),
                processor.process(null, commander));
        ToolProcessingContext member = ToolProcessingContext.builder().member(true).agentId(8L).teamId(9L)
                .permissionMode(AgentPermissionMode.APPROVAL_REQUIRED).build();
        assertEquals(List.of(ToolCatalog.SEND_MAIL_TO_AGENT), processor.process(
                List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.PEEK_TEAMMATE_STATE), member));
        assertTrue(processor.process(List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.SEND_MAIL_TO_AGENT), root()).isEmpty());
    }

    @Test
    void readOnlyReviewAndPlanModeStripMutationAndTerminalTools() {
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.READ_FILE));
        ToolProcessingContext context = ToolProcessingContext.builder().agentId(7L).teamId(9L).vision(true).requirePlan(true)
                .skillRoot(Path.of("skills")).permissionMode(AgentPermissionMode.APPROVAL_REQUIRED).build();
        List<String> tools = processor.process(List.of(ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE,
                ToolCatalog.EXECUTE_COMMAND, ToolCatalog.MANAGE_COMMAND), context);
        assertEquals(List.of(ToolCatalog.READ_FILE), tools);
        assertFalse(tools.contains(ToolCatalog.EXECUTE_COMMAND));
        assertFalse(tools.contains(ToolCatalog.MANAGE_COMMAND));
        assertFalse(tools.contains(ToolCatalog.READ_IMAGE));
        assertFalse(tools.contains(ToolCatalog.CALL_SUB_AGENT));
    }

    @Test
    void registeredReadOnlyAdditionsSurviveTheSameFilter() {
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.READ_IMAGE, ToolCatalog.CREATE_PLAN));
        ToolProcessingContext context = ToolProcessingContext.builder().vision(true).requirePlan(true).skillRoot(Path.of("skills"))
                .permissionMode(AgentPermissionMode.READ_ONLY_REVIEW).build();
        assertEquals(Set.of(ToolCatalog.READ_IMAGE, ToolCatalog.CREATE_PLAN),
                Set.copyOf(processor.process(List.of(ToolCatalog.EDIT_FILE), context)),
                "补齐的只读工具要能过只读滤网；read_skill 属内核工具，不再由业务侧补");
    }

    @Test
    void availableMcpDoesNotInjectKernelEntries() {
        McpConfig mcp = mock(McpConfig.class);
        when(mcp.getMcp()).thenReturn(List.of(mock(McpConfig.MCP.class)));
        ToolProcessingContext context = ToolProcessingContext.builder().mcpConfig(mcp).permissionMode(AgentPermissionMode.APPROVAL_REQUIRED).build();
        assertEquals(List.of(), processor.process(List.of(), context),
                "MCP 三级入口是框架内核工具，默认注册且恒准入，业务侧不再往名单里塞");
    }

    @Test
    void theReadOnlyFilterLeavesTheInjectedListAlone() {
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.READ_FILE));
        McpConfig mcp = mock(McpConfig.class);
        when(mcp.getMcp()).thenReturn(List.of(mock(McpConfig.MCP.class)));
        ToolProcessingContext context = ToolProcessingContext.builder().mcpConfig(mcp)
                .permissionMode(AgentPermissionMode.READ_ONLY_REVIEW).build();
        assertEquals(List.of(ToolCatalog.READ_FILE), processor.process(List.of(ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE), context),
                "只读档只按注册表剔除写工具，内核工具本来就不在名单里");
    }

    private ToolProcessingContext root() {
        return ToolProcessingContext.builder().permissionMode(AgentPermissionMode.APPROVAL_REQUIRED).build();
    }
}
