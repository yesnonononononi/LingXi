package com.summit.dp.workflow.infrastructure.tools.file.read;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;

import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import com.summit.dp.shared.exception.ClientException;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
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
            ReadFileRequest request = objectMapper.readValue(toolExecution.getArgs(), ReadFileRequest.class);
            throwIf(request == null, "读取文件参数不能为空");
            throwIf(request.getPath() == null || request.getPath().isBlank(), "读取文件路径不能为空");
            int start = Objects.requireNonNullElse(request.getStartLine(), 0);
            int requestedEnd = Objects.requireNonNullElse(request.getEndLine(), Integer.MAX_VALUE);
            throwIf(start < 0 || requestedEnd < 0, "读取文件的行号不能小于 0");
            throwIf(start > requestedEnd, "读取文件的起始行不能大于结束行");

            WorkspaceFiles files = toolExecution.getWorkspace().bridge().files();
            Path path = toolExecution.getWorkspace().resolve(request.getPath()).normalize();
            log.info("读取文件: path={}, startLine={}, endLine={}", path, request.getStartLine(), request.getEndLine());

            // 文件编码不能继承 Windows 终端编码，否则中文内容会被误解码。
            String content = files.readString(path, StandardCharsets.UTF_8);
            if (request.getStartLine() != null || request.getEndLine() != null) {
                List<String> lines = content.lines().toList();
                int end = Math.min(requestedEnd, lines.size() - 1);
                content = start >= lines.size() ? "" : String.join("\n", lines.subList(start, end + 1));
            }

            return ToolExecuteResult.success(content);
        } catch (Exception e) {
            return ToolExecuteResult.err("读取文件失败: " + e.getMessage());
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }

}
