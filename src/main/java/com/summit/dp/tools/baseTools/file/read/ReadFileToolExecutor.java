package com.summit.dp.tools.baseTools.file.read;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;

import com.summit.dp.tools.baseTools.arguments.ReadFileRequest;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

import java.io.IOException;
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
            String content = read(bridge, path,
                    toolExecution.getWorkspace().runtimeEnvironment().charset(),
                    request.getStartLine(), request.getEndLine());

            return ToolExecuteResult.success(content);
        } catch (Exception e) {
            return ToolExecuteResult.err("tool execute failed : " + e);
        }
    }

    /**
     * Reads the file through the workspace bridge and returns the content by
     * line range; when both bounds are null the whole file is returned.
     */
    private String read(WorkspaceBridge bridge, Path path, java.nio.charset.Charset charset,
                        Integer startLine, Integer endLine) throws IOException {
        if (startLine == null && endLine == null) {
            return bridge.readString(path, charset);
        }
        List<String> lines = bridge.readLines(path, charset);
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
