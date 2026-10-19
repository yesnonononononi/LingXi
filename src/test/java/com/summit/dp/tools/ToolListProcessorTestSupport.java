package com.summit.dp.tools;

import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.tools.application.service.ToolListProcessor;

import java.util.Set;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

public final class ToolListProcessorTestSupport {
    private ToolListProcessorTestSupport() { }

    public static ToolListProcessor create() {
        ToolCatalog catalog = mock(ToolCatalog.class);
        when(catalog.readOnlyNames()).thenReturn(Set.of(ToolCatalog.READ_FILE, ToolCatalog.READ_IMAGE,
                ToolCatalog.READ_SKILL, ToolCatalog.SEND_MAIL_TO_AGENT, ToolCatalog.REQUIRE_CHOICE,
                ToolCatalog.CREATE_PLAN, ToolCatalog.SEARCH_TOOL, ToolCatalog.LIST_MCP_TOOLS, ToolCatalog.WEB_SEARCH));
        return new ToolListProcessor(catalog);
    }
}
