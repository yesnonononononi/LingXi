package com.summit.dp.tools.application.service.impl;

import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.tools.application.service.ToolService;
import com.summit.dp.tools.application.vo.ToolVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

@Service
@RequiredArgsConstructor
public class ToolServiceImpl implements ToolService {
    private final ToolRegistry toolRegistry;
    private final ToolCatalog toolCatalog;

    @Override
    public Result<List<ToolVO>> list() {
        ArrayList<ToolVO> result = new ArrayList<>();

        if (toolRegistry != null && toolRegistry.getTools() != null) {
            for (ToolDefinition<? extends ToolExecutor> toolSpec : toolRegistry.getTools().values()) {
                if (toolCatalog != null && toolCatalog.isDelegationTool(toolSpec.name())) {
                    continue;
                }
                result.add(ToolVO.builder()
                        .name(toolSpec.name())
                        .description(toolSpec.description())
                        .readOnly(toolSpec.readOnly())
                        .build());
            }
        }
        result.sort(Comparator.comparing(ToolVO::name));
        return Result.success(result);
    }
}
