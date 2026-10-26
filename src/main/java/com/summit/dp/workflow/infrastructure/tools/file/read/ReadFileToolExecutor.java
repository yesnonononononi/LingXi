package com.summit.dp.workflow.infrastructure.tools.file.read;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.IntegerValue;
import com.summit.core.anno.type.ObjectValue;
import com.summit.core.anno.type.ToolProperty;
import com.summit.core.anno.type.Value;
import com.summit.core.anno.type.ValueType;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Objects;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@Tool(
    id = ToolCatalog.READ_FILE,
    name = ToolCatalog.READ_FILE,
    executor = ReadFileToolExecutor.class,
    description = "Read file content, optionally limited to a startLine/endLine range.",
    parameters = @ObjectValue(
        properties = {
            @ToolProperty(key = "path", value = @Value(
                type = ValueType.STRING,
                description = "File path it is a required parameter")),
            @ToolProperty(key = "startLine", value = @Value(
                type = ValueType.INTEGER,
                description = "Zero-based start line, inclusive. Defaults to 0. Omit both line bounds to read the entire file.",
                integerValue = @IntegerValue(minimum = 0))),
            @ToolProperty(key = "endLine", value = @Value(
                type = ValueType.INTEGER,
                description = "Zero-based end line, inclusive. Must not precede startLine. Defaults to the last line.",
                integerValue = @IntegerValue(minimum = 0)))
        },
        required = {"path"}),
    concurrentPolicy = ConcurrentPolicy.READ_ONLY,
    maxOutput = 3_000,
    timeout = 30L)
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
