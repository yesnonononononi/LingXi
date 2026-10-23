package com.summit.dp.tools.baseTools.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.adapter.langchain4j.codec.tool.ToolCodecAdapter;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.workflow.infrastructure.tools.arguments.WebSearchArguments;
import com.summit.dp.workflow.infrastructure.tools.config.CommonToolConfiguration;
import com.summit.dp.workflow.infrastructure.tools.config.properties.WebSearchToolProperties;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchEngine;
import com.summit.dp.workflow.infrastructure.tools.web.WebSearchExecutor;
import dev.langchain4j.agent.tool.ToolSpecification;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

class WebSearchToolSchemaTest {
    private static final Pattern PROPERTY_NAME = Pattern.compile("^[a-zA-Z0-9_.-]{1,64}$");

    private final ObjectMapper mapper = new ObjectMapper();
    private final ToolDefinition<WebSearchExecutor> definition = new CommonToolConfiguration()
            .webSearchToolDefinition(mock(WebSearchEngine.class), new WebSearchToolProperties(), mapper);

    @Test
    void convertedParameterNamesMeetProviderRules() {
        ToolSpecification specification = new ToolCodecAdapter().toFrameworkTool(definition);

        assertEquals(4, specification.parameters().properties().size());
        for (String name : specification.parameters().properties().keySet()) {
            assertTrue(PROPERTY_NAME.matcher(name).matches(), "模型参数名不符合上游规则: " + name);
        }
    }

    @Test
    void advertisedParameterNamesMatchArgumentContract() throws Exception {
        JsonNode properties = mapper.readTree(definition.parametersJsonSchema()).path("properties");
        Set<String> names = new HashSet<>();
        properties.fieldNames().forEachRemaining(names::add);
        assertEquals(Set.of("query", "max_results", "start_date", "end_date"), names);

        WebSearchArguments arguments = mapper.readValue("""
                {"query":"lingxi","max_results":2,"start_date":"2026-10-01","end_date":"2026-10-23"}
                """, WebSearchArguments.class);

        assertEquals("lingxi", arguments.getQuery());
        assertEquals("2", arguments.getMaxResults());
        assertEquals("2026-10-01", arguments.getStartDate());
        assertEquals("2026-10-23", arguments.getEndDate());
    }
}
