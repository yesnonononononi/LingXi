package com.summit.dp.agent.infrastructure.tool;

import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.shared.model.ToolCatalog;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;

import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

/** 基于运行时 {@link ToolRegistry} 的工具目录实现。 */
@Component
public class RegistryToolCatalog implements ToolCatalog {

    private final ObjectProvider<ToolRegistry> registry;

    public RegistryToolCatalog(ObjectProvider<ToolRegistry> registry) {
        this.registry = registry;
    }

    @Override
    public Set<String> names() {
        Map<String, ToolDefinition<? extends ToolExecutor>> tools = tools();
        return tools == null ? Set.of() : Set.copyOf(tools.keySet());
    }

    @Override
    public Set<String> readOnlyNames() {
        Map<String, ToolDefinition<? extends ToolExecutor>> tools = tools();
        if (tools == null) return Set.of();

        Set<String> result = new LinkedHashSet<>();
        tools.forEach((name, definition) -> {
            if (definition != null && definition.readOnly()) result.add(name);
        });
        return Set.copyOf(result);
    }

    private Map<String, ToolDefinition<? extends ToolExecutor>> tools() {
        ToolRegistry resolved = registry.getObject();
        return resolved == null ? null : resolved.getTools();
    }
}
