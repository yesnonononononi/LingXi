package com.summit.dp.workflow.infrastructure.tools.file.read;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;

import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

@Slf4j
public class ReadFileToolExecutor implements ToolExecutor {
    private final ObjectMapper objectMapper;

    public ReadFileToolExecutor(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        try {
            ReadFileRequest request = resolveArgs(toolExecution);

            log.info("【ToolCall】 read_file :{}", request.getPath());

            WorkspaceBridge bridge = toolExecution.getWorkspace().bridge();

            Path path = Path.of(request.getPath());

            String content = read(bridge, path, request.getStartLine(), request.getEndLine());

            return ToolExecuteResult.success(content);
        } catch (Exception e) {
            return ToolExecuteResult.err("tool execute failed : " + e);
        }
    }

    private String read(WorkspaceBridge bridge, Path path, Integer startLine, Integer endLine) throws IOException {
        // 文件统一使用 UTF-8，不能沿用 Windows 终端的 OEM 编码。
        if (startLine == null && endLine == null) {
            return bridge.readString(path, StandardCharsets.UTF_8);
        }
        List<String> lines = bridge.readLines(path, StandardCharsets.UTF_8);

        int start = Objects.requireNonNullElse(startLine, 0);
        int end = Math.min(Objects.requireNonNullElse(endLine, Integer.MAX_VALUE), lines.size() - 1);
        List<String> result = new ArrayList<>();
        for (int current = start; current <= end; current++) {
            result.add(lines.get(current));
        }
        return String.join("\n", result);
    }

    private ReadFileRequest resolveArgs(ToolExecution execution) throws JsonProcessingException {
        ReadFileRequest request = objectMapper.readValue(execution.getArgs(), ReadFileRequest.class);
        request.setPath(String.valueOf(execution.getWorkspace().resolve(request.getPath()).normalize()));
        return request;
    }

}
