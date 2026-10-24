package com.summit.dp.tools;

import com.summit.core.conf.McpConfig;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.tools.application.service.ToolListProcessor;
import com.summit.dp.tools.application.service.ToolProcessingContext;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ToolListProcessorTest {
    private final ToolCatalog catalog = mock(ToolCatalog.class);
    private final ToolListProcessor processor = new ToolListProcessor(catalog);

    @Test
    void onlyTheDefaultAgentReceivesTheDefaultTools() {
        ToolProcessingContext context = ToolProcessingContext.builder().defaultAgent(true).accessMode(AgentAccessMode.IN_WORKSPACE).build();
        List<String> tools = processor.process(null, context);
        assertTrue(tools.contains(ToolCatalog.READ_FILE));
        assertTrue(tools.contains(ToolCatalog.REQUIRE_CHOICE));
        assertTrue(tools.contains(ToolCatalog.MANAGE_COMMAND));
        assertFalse(tools.contains(ToolCatalog.READ_IMAGE));
        assertFalse(tools.contains(ToolCatalog.CALL_SUB_AGENT));
        assertEquals(List.of(), processor.process(null, root()));
    }

    @Test
    void visionAddsTheImageToolAndDisabledVisionRemovesEvenExplicitSelection() {
        assertEquals(List.of(ToolCatalog.READ_FILE, ToolCatalog.READ_IMAGE), processor.process(List.of(ToolCatalog.READ_FILE),
                ToolProcessingContext.builder().vision(true).accessMode(AgentAccessMode.IN_WORKSPACE).build()));
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
                .accessMode(AgentAccessMode.IN_WORKSPACE).build();
        assertEquals(List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.PEEK_TEAMMATE_STATE, ToolCatalog.SEND_MAIL_TO_AGENT),
                processor.process(null, commander));
        ToolProcessingContext member = ToolProcessingContext.builder().member(true).agentId(8L).teamId(9L)
                .accessMode(AgentAccessMode.IN_WORKSPACE).build();
        assertEquals(List.of(ToolCatalog.SEND_MAIL_TO_AGENT), processor.process(
                List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.PEEK_TEAMMATE_STATE), member));
        assertTrue(processor.process(List.of(ToolCatalog.CALL_SUB_AGENT, ToolCatalog.SEND_MAIL_TO_AGENT), root()).isEmpty());
    }

    @Test
    void readOnlyRestrictionsRunAfterAllAdditionsAndKeepTerminalControls() {
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.READ_FILE));
        ToolProcessingContext context = ToolProcessingContext.builder().agentId(7L).teamId(9L).vision(true).requirePlan(true)
                .skillRoot(Path.of("skills")).accessMode(AgentAccessMode.READ_ONLY_IN_WORKSPACE).build();
        List<String> tools = processor.process(List.of(ToolCatalog.READ_FILE, ToolCatalog.EDIT_FILE,
                ToolCatalog.EXECUTE_COMMAND, ToolCatalog.MANAGE_COMMAND), context);
        assertEquals(List.of(ToolCatalog.READ_FILE, ToolCatalog.EXECUTE_COMMAND, ToolCatalog.MANAGE_COMMAND), tools);
        assertFalse(tools.contains(ToolCatalog.READ_IMAGE));
        assertFalse(tools.contains(ToolCatalog.CALL_SUB_AGENT));
    }

    @Test
    void registeredReadOnlyAdditionsSurviveTheSameFilter() {
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.READ_IMAGE, ToolCatalog.READ_SKILL, ToolCatalog.CREATE_PLAN));
        ToolProcessingContext context = ToolProcessingContext.builder().vision(true).requirePlan(true).skillRoot(Path.of("skills"))
                .accessMode(AgentAccessMode.READ_ONLY_IN_WORKSPACE).build();
        assertEquals(Set.of(ToolCatalog.READ_IMAGE, ToolCatalog.READ_SKILL, ToolCatalog.CREATE_PLAN),
                Set.copyOf(processor.process(List.of(ToolCatalog.EDIT_FILE), context)));
    }

    @Test
    void availableMcpAddsBothDiscoveryTools() {
        McpConfig mcp = mock(McpConfig.class);
        when(mcp.getMcp()).thenReturn(List.of(mock(McpConfig.MCP.class)));
        ToolProcessingContext context = ToolProcessingContext.builder().mcpConfig(mcp).accessMode(AgentAccessMode.IN_WORKSPACE).build();
        assertEquals(List.of(ToolCatalog.LIST_MCP_TOOLS, ToolCatalog.SEARCH_TOOL), processor.process(List.of(), context));
    }

    private ToolProcessingContext root() {
        return ToolProcessingContext.builder().accessMode(AgentAccessMode.IN_WORKSPACE).build();
    }
}
