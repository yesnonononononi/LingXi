package com.summit.dp.tools.application.service.impl;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.tools.application.port.ToolDefinitionQuery;
import com.summit.dp.tools.application.service.ToolService;
import com.summit.dp.tools.application.vo.ToolVO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ToolServiceImpl implements ToolService {
    private final ToolDefinitionQuery definitions;

    @Override
    public Result<List<ToolVO>> list() {
        return Result.success(definitions.list());
    }
}
