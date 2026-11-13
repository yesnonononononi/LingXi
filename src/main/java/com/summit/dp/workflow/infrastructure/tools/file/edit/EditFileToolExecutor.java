package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.*;
import com.summit.core.exception.OutWorkSpaceException;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.*;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import com.summit.dp.workflow.infrastructure.tools.file.FileEditRecorder;
import com.summit.dp.workflow.infrastructure.tools.file.FileEditReport;
import com.summit.dp.workflow.infrastructure.tools.file.FileMutation;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

/**
 * 只在已有文件里做局部编辑：新建与整文件写入归 {@code write_file}。
 *
 * <p>必须先写文件再登记；摘要随工具结束事件发布，不能另发第二份编辑事件。</p>
 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
        id = ToolCatalog.EDIT_FILE,
        name = ToolCatalog.EDIT_FILE,
        executor = EditFileToolExecutor.class,
        description = "Edit an existing UTF-8 text file using unique oldText or anchor matches. LF and CRLF are equivalent for matching; all other characters must match exactly. `anchor` and `oldText` match a text fragment, not a whole line: INSERT_* place `newText` immediately before/after the matched fragment and add no line break, so include the newline in `newText` yourself when inserting a whole line. New text follows the local line ending, while untouched content is preserved. Supports REPLACE, INSERT_BEFORE, INSERT_AFTER and DELETE. The file must already exist and is never created here: use write_file for a new file, a full-content replacement, or a prepend/append without an anchor. Returns an edit summary.",
        parameters = @ObjectValue(
                properties = {
                        @ToolProperty(key = "type", value = @Value(
                                type = ValueType.STRING,
                                description = "INSERT_BEFORE or INSERT_AFTER insert newText right before/after the anchor fragment with no line break added; REPLACE swaps oldText for newText; DELETE removes oldText.",
                                stringValue = @StringValue(enums = {"INSERT_BEFORE", "INSERT_AFTER", "REPLACE", "DELETE"}))),
                        @ToolProperty(key = "anchor", value = @Value(
                                type = ValueType.STRING,
                                description = "The text fragment an INSERT_* operation anchors on: the insert point sits immediately before or after this fragment with no line break added. Required for INSERT_* unless the target file is empty.")),
                        @ToolProperty(key = "path", value = @Value(
                                type = ValueType.STRING,
                                description = "File path: a relative path resolves against the workspace root. A path outside the workspace is rejected unless the session runs with full access")),
                        @ToolProperty(key = "oldText", value = @Value(
                                type = ValueType.STRING,
                                description = "Exact original text, required for REPLACE and DELETE. Must match exactly once.")),
                        @ToolProperty(key = "newText", value = @Value(
                                type = ValueType.STRING,
                                description = "Required for REPLACE and INSERT_*. An explicit empty string is allowed for REPLACE. Ignored for DELETE."))
                },
                required = {"type", "path"}),
        concurrentPolicy = ConcurrentPolicy.SERIAL_MUTATION,
        maxOutput = 200,
        timeout = 30L)
public class EditFileToolExecutor implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final FileEditRecorder fileEditRecorder;
    private static final int DEFAULT_AROUND_LINE = 3;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        String args = toolExecution.getArgs();
        try {
            EditFileRequest request = objectMapper.readValue(args, EditFileRequest.class);
            throwIf(request == null, "编辑文件参数不能为空");
            throwIf(request.getPath() == null || request.getPath().isBlank(), "编辑文件路径不能为空");
            throwIf(request.getType() == null || request.getType().isBlank(), "文件编辑类型不能为空");
            EditType type = EditType.fromString(request.getType());
            // 与 FileUpdater/FileInsertor 的校验同义，但入口这层必须保留：模型最常漏的就是 newText，
            // 这里才给得出「DELETE 不必传」的引导，下沉之后就只剩「替换文件时必须提供 newText」。
            throwIf(type != EditType.DELETE && request.getNewText() == null,
                    "编辑文件时必须提供 newText，删除文本请显式传空字符串或使用 DELETE");
            log.info("编辑文件: path={}, type={}", request.getPath(), type);

            Workspace workspace = toolExecution.getWorkspace();
            // 边界与链接复核交给框架；必须在读旧内容之前拦，越界读本身就是信息泄露。
            Path target = AgentAccessMode.from(toolExecution.getAttributes()).allowsOutsideWorkspace()
                    ? workspace.resolve(request.getPath())
                    : workspace.resolveInside(request.getPath());
            WorkspaceFiles files = workspace.bridge().files();
            Charset charset = StandardCharsets.UTF_8;
            // 不存在就明确指路：编造空内容会让「打错路径」变成「悄悄新建一个文件」。
            throwIf(!files.exists(target), "文件不存在，新建文件请使用 write_file");
            String oldContent = files.readString(target, charset);

            FileEditorResult editRes = FileEditor.edit(request, oldContent, charset, DEFAULT_AROUND_LINE);
            if (!editRes.isSuccess()) {
                return ToolExecuteResult.err(editRes.getErrMsg());
            }

            // 定位成功后才能创建目录和写入，失败不得产生文件副作用。
            Path parent = target.getParent();
            if (parent != null && !files.exists(parent)) {
                files.createDirectories(parent);
            }
            String newContent = editRes.getData().newContent();
            files.writeString(target, newContent, charset);

            FileEditReport report = fileEditRecorder.record(toolExecution, new FileMutation(
                    request.getPath(),
                    target.toAbsolutePath().normalize().toString(),
                    oldContent,
                    newContent,
                    editRes.getData().oldStartLine(),
                    editRes.getData().oldEndLine(),
                    editRes.getData().newStartLine(),
                    editRes.getData().newEndLine()));
            return ToolExecuteResult.success(objectMapper.writeValueAsString(report.summary()),
                    ToolResultType.NORMAL, report.metadata());

        } catch (OutWorkSpaceException outsideWorkspace) {
            return ToolExecuteResult.err("编辑文件只能在工作区内进行，修改项目外文件请切换到完全访问档位");
        } catch (Exception e) {
            return ToolExecuteResult.err("编辑文件失败: " + e.getMessage());
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }
}