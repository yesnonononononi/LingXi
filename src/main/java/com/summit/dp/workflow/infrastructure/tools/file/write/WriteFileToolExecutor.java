package com.summit.dp.workflow.infrastructure.tools.file.write;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.*;
import com.summit.core.exception.OutWorkSpaceException;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.*;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.infrastructure.tools.arguments.WriteFileRequest;
import com.summit.dp.workflow.infrastructure.tools.file.FileEditRecorder;
import com.summit.dp.workflow.infrastructure.tools.file.FileEditReport;
import com.summit.dp.workflow.infrastructure.tools.file.FileMutation;
import com.summit.dp.workflow.infrastructure.tools.file.edit.FileEditorResult;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

/**
 * 整文件写入：新建、全文替换、头插、追加，全都不需要锚点。
 *
 * <p>成立前提是文件真的落盘；登记在落盘之后，不能把没写进去的内容当成可回滚记录。</p>
 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
        id = ToolCatalog.WRITE_FILE,
        name = ToolCatalog.WRITE_FILE,
        executor = WriteFileToolExecutor.class,
        description = "Write a UTF-8 text file without any match anchor. CREATE writes a new file and fails when the path already exists; OVERRIDE replaces the whole content of an existing file; PREPEND puts `content` before the existing content; APPEND puts it after. PREPEND and APPEND insert `content` verbatim and add no line break, so include the leading or trailing newline yourself when the text must start on its own line. Missing parent directories are created. Use edit_file for partial edits inside a file. Returns a write summary.",
        parameters = @ObjectValue(
                properties = {
                        @ToolProperty(key = "type", value = @Value(
                                type = ValueType.STRING,
                                description = "CREATE writes a new file at the given path and fails if it already exists; OVERRIDE replaces the whole content of an existing file; PREPEND inserts content at the very beginning; APPEND inserts content at the very end.",
                                stringValue = @StringValue(enums = {"CREATE", "OVERRIDE", "PREPEND", "APPEND"}))),
                        @ToolProperty(key = "path", value = @Value(
                                type = ValueType.STRING,
                                description = "File path: a relative path resolves against the workspace root. A path outside the workspace is rejected unless the session runs with full access")),
                        @ToolProperty(key = "content", value = @Value(
                                type = ValueType.STRING,
                                description = "The full text to write, or the fragment to prepend/append. An explicit empty string is allowed for CREATE (empty file) and OVERRIDE (truncate); PREPEND and APPEND require non-empty content."))
                },
                required = {"type", "path", "content"}),
        concurrentPolicy = ConcurrentPolicy.SERIAL_MUTATION,
        maxOutput = 200,
        timeout = 30L)
public class WriteFileToolExecutor implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final FileEditRecorder fileEditRecorder;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        String args = toolExecution.getArgs();
        try {
            WriteFileRequest request = objectMapper.readValue(args, WriteFileRequest.class);
            throwIf(request == null, "写入文件参数不能为空");
            throwIf(request.getPath() == null || request.getPath().isBlank(), "写入文件路径不能为空");
            throwIf(request.getType() == null || request.getType().isBlank(), "文件写入类型不能为空");
            throwIf(request.getContent() == null, "写入文件时必须提供 content，创建空文件请显式传空字符串");
            WriteType type = WriteType.fromString(request.getType());
            log.info("写入文件: path={}, type={}", request.getPath(), type);

            Workspace workspace = toolExecution.getWorkspace();
            // 边界与链接复核交给框架；必须在读旧内容之前拦，越界读本身就是信息泄露。
            Path target = AgentPermissionMode.from(toolExecution.getAttributes()).allowsOutsideWorkspace()
                    ? workspace.resolve(request.getPath())
                    : workspace.resolveInside(request.getPath());
            WorkspaceFiles files = workspace.bridge().files();
            Charset charset = StandardCharsets.UTF_8;

            // 存在性属于写入语义本身：CREATE 不许顶掉别人的文件，其余三种必须落在已有文件上。
            boolean existed = files.exists(target);
            throwIf(type == WriteType.CREATE && existed, "文件已存在，覆盖全文请使用 OVERRIDE，局部修改请使用 edit_file");
            throwIf(type != WriteType.CREATE && !existed, "文件不存在，新建文件请使用 CREATE");
            String oldContent = existed ? files.readString(target, charset) : null;

            FileEditorResult writeResult = FileWriter.write(type, request.getContent(),
                    oldContent == null ? "" : oldContent);
            if (!writeResult.isSuccess()) {
                return ToolExecuteResult.err(writeResult.getErrMsg());
            }

            // 计算成功后才创建目录和写入，失败不得产生文件副作用。
            Path parent = target.getParent();
            if (parent != null && !files.exists(parent)) {
                files.createDirectories(parent);
            }
            String newContent = writeResult.getData().newContent();
            files.writeString(target, newContent, charset);

            FileEditReport report = fileEditRecorder.record(toolExecution, new FileMutation(
                    request.getPath(),
                    target.toAbsolutePath().normalize().toString(),
                    oldContent,
                    newContent,
                    writeResult.getData().oldStartLine(),
                    writeResult.getData().oldEndLine(),
                    writeResult.getData().newStartLine(),
                    writeResult.getData().newEndLine()));
            return ToolExecuteResult.success(objectMapper.writeValueAsString(report.summary()),
                    ToolResultType.NORMAL, report.metadata());

        } catch (OutWorkSpaceException outsideWorkspace) {
            return ToolExecuteResult.err("写入文件只能在工作区内进行，修改项目外文件请切换到完全访问档位");
        } catch (Exception e) {
            return ToolExecuteResult.err("写入文件失败: " + e.getMessage());
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }
}