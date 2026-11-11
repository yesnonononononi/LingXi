package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.anno.Tool;
import com.summit.core.anno.type.*;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.*;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import com.summit.dp.workflow.infrastructure.tools.file.record.ContentDigest;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import org.springframework.stereotype.Component;

import java.io.Serializable;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 必须先写文件再登记；摘要随工具结束事件发布，不能另发第二份编辑事件。
 */
@Slf4j
@RequiredArgsConstructor
@Component
@Tool(
        id = ToolCatalog.EDIT_FILE,
        name = ToolCatalog.EDIT_FILE,
        executor = EditFileToolExecutor.class,
        description = "Edit UTF-8 text using unique oldText or anchor matches. LF and CRLF are equivalent for matching; all other characters must match exactly. New text follows the local line ending, while untouched content is preserved. Supports REPLACE, INSERT_BEFORE, INSERT_AFTER and DELETE; INSERT_* can create files. Returns an edit summary.",
        parameters = @ObjectValue(
                properties = {
                        @ToolProperty(key = "type", value = @Value(
                                type = ValueType.STRING,
                                description = "INSERT_* : insert content behind or in front of anchor. ",
                                stringValue = @StringValue(enums = {"INSERT_BEFORE", "INSERT_AFTER", "REPLACE", "DELETE"}))),
                        @ToolProperty(key = "anchor", value = @Value(
                                type = ValueType.STRING,
                                description = "The anchor of Insert operation it is a required parameter if type in terms of INSERT unless want to insert a empty file")),
                        @ToolProperty(key = "path", value = @Value(
                                type = ValueType.STRING,
                                description = "File path relative to the workspace root. Do not use absolute paths it is a required parameter")),
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
    private final Differ differ;
    private final FileRecordManager fileRecordManager;
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
            throwIf(type != EditType.DELETE && request.getNewText() == null,
                    "编辑文件时必须提供 newText，删除文本请显式传空字符串或使用 DELETE");
            log.info("编辑文件: path={}, type={}", request.getPath(), type);

            Workspace workspace = toolExecution.getWorkspace();
            WorkspaceFiles files = workspace.bridge().files();
            Charset charset = StandardCharsets.UTF_8;
            Path target = workspace.resolve(request.getPath());
            boolean existed = files.exists(target);
            String oldContent = existed ? files.readString(target, charset) : null;

            FileEditorResult editRes = FileEditor.edit(request, oldContent == null ? "" : oldContent,
                    charset, DEFAULT_AROUND_LINE);
            if (!editRes.isSuccess()) {
                return ToolExecuteResult.err(editRes.getErrMsg());
            }

            // 定位成功后才能创建目录和写入，失败不得产生文件副作用。
            Path parent = target.getParent();
            if (parent != null && !files.exists(parent)) {
                files.createDirectories(parent);
            }
            files.writeString(target, editRes.getData().newContent(), charset);

            EditOutcome outcome = new EditOutcome(
                    target.toAbsolutePath().normalize().toString(),
                    existed,
                    oldContent,
                    editRes.getData().newContent(),
                    editRes.getData().oldStartLine(),
                    editRes.getData().oldEndLine(),
                    editRes.getData().newStartLine(),
                    editRes.getData().newEndLine(),
                    differ.diff(
                            request.getPath(),
                            oldContent == null ? "" : oldContent,
                            editRes.getData().newContent())
            );
            // 登记必须在落盘之后，不能把未写入的内容当成可回滚记录。
            Serializable recordId = recordEdit(toolExecution, outcome);
            return ToolExecuteResult.success(objectMapper.writeValueAsString(outcome.toSummary()),
                    ToolResultType.NORMAL, buildMetadata(outcome, recordId));

        } catch (Exception e) {
            return ToolExecuteResult.err("编辑文件失败: " + e.getMessage());
        }
    }

    /**
     * 取本轮的业务轮次 ID（{@code chat_turn} 主键）。
     *
     * <p><b>不能用 {@code toolExecution.getTurnId()}</b>：框架 {@code DefaultToolExecutionManager}
     * 把它赋成了 {@code command.executionId()}，那是执行标识而不是轮次主键。轮次汇总与整轮撤销
     * 都按业务轮次定位记录，用执行标识当轮次会让它们一条也匹配不到 —— 清单恒空、撤销恒 0，
     * 且不会报错。</p>
     *
     * <p>真正的业务轮次在事件元数据里：{@code RequestPreparer} 用
     * {@code ExecutionEventMetadata.of(...)} 写入，框架随 {@code eventMetaData} 一起注入工具。</p>
     *
     * @return 业务轮次 ID 的字符串形态；元数据缺失时返回 {@code null} ——
     *         该编辑仍登记为可回滚记录，只是不归属任何轮次，因而不进轮次清单
     */
    private String businessTurnId(ToolExecution toolExecution) {
        Object turnId = toolExecution.getEventMetaData().get(ExecutionEventMetadata.TURN_ID);
        return turnId == null ? null : turnId.toString();
    }

    private void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }

    private Serializable recordEdit(ToolExecution toolExecution, EditOutcome outcome) {
        try {
            return fileRecordManager.record(toolExecution.getExecutionId(), businessTurnId(toolExecution),
                    FileRecord.builder()
                            .filePath(outcome.path())
                            // 基线只对分段起点有效，是否保留由登记器判定；这里如实给出「改之前是什么」。
                            .baseline(outcome.existed() ? outcome.oldContent() : null)
                            .diff(outcome.diffResult().unifiedDiff())
                            .plusLines(outcome.plusLines())
                            .minusLines(outcome.minusLines())
                            // 改完之后的摘要：登记下一条时靠它发现链被工具外的修改打断。
                            .contentDigest(ContentDigest.compute(outcome.newContent()))
                            .build());
        } catch (Exception e) {
            // 文件已经落盘；登记失败仍返回写入结果，只是这一改动事后查不到差异。
            log.warn("登记已落盘编辑失败: filePath={}, sessionId={}, reason={}",
                    outcome.path(), toolExecution.getExecutionId(), e.getMessage());
            return null;
        }
    }

    /**
     * 全文不入事件，避免超出 SSE 帧预算；前端通过 recordId 查询记录。
     */
    private Map<String, Object> buildMetadata(EditOutcome outcome, Serializable recordId) {
        Map<String, Object> fileEdit = new LinkedHashMap<>();
        fileEdit.put("filePath", outcome.path());
        if (recordId != null) {
            fileEdit.put("recordId", String.valueOf(recordId));
        }
        fileEdit.put("plusLines", outcome.plusLines());
        fileEdit.put("minusLines", outcome.minusLines());
        // 只给行号不给内容：前端据此按行渲染 diff，不需要额外请求，也不撞 SSE 帧预算。
        fileEdit.put("oldStartLine", outcome.oldStartLine());
        fileEdit.put("oldEndLine", outcome.oldEndLine());
        fileEdit.put("newStartLine", outcome.newStartLine());
        fileEdit.put("newEndLine", outcome.newEndLine());
        return Map.of("fileEdit", fileEdit);
    }

    /**
     * 模型只收摘要，完整差异留给前端，避免重复传输全文并截断结果。
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record EditSummary(String path, boolean created, Integer plusLines, Integer minusLines,
                               String diffError) {
    }

    private record EditOutcome(String path, boolean existed,
                               String oldContent, String newContent,
                               int oldStartLine, int oldEndLine, int newStartLine, int newEndLine,
                               DiffResult diffResult) {

        boolean created() {
            return !existed;
        }

        int plusLines() {
            return diffResult == null ? 0 : diffResult.plusLines();
        }

        int minusLines() {
            return diffResult == null ? 0 : diffResult.minusLines();
        }

        EditSummary toSummary() {
            if (diffResult == null) {
                return new EditSummary(path, created(), null, null, "diff unavailable");
            }
            if (!diffResult.isSuccess()) {
                return new EditSummary(path, created(), null, null, diffResult.getErrMsg());
            }
            return new EditSummary(path, created(), plusLines(), minusLines(), null);
        }
    }
}
