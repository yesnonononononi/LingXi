package com.summit.dp.workflow.infrastructure.harness.tool;

import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.tools.application.port.ToolDefinitionQuery;
import com.summit.dp.tools.application.vo.ToolVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** 协作工具只由工作流显式授予，不能出现在普通配置目录。 */
@Component
@RequiredArgsConstructor
public class HarnessToolDefinitionQuery implements ToolDefinitionQuery {
    private final ToolRegistry toolRegistry;
    private final ToolCatalog toolCatalog;

    @Override
    public List<ToolVO> list() {
        List<ToolVO> result = new ArrayList<>();
        if (toolRegistry != null && toolRegistry.getTools() != null) {
            for (ToolDefinition<? extends ToolExecutor> definition : toolRegistry.getTools().values()) {
                if (toolCatalog != null && toolCatalog.isDelegationTool(definition.name())) continue;
                result.add(new ToolVO(definition.name(), definition.description(), definition.readOnly()));
            }
        }
        result.sort(Comparator.comparing(ToolVO::name));
        return result;
    }
}
