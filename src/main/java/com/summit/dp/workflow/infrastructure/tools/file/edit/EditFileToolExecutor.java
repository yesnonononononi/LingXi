package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.*;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.arguments.EditFileRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import java.io.IOException;
import java.io.Serializable;
import java.nio.charset.Charset;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/** 必须先写文件再登记；摘要随工具结束事件发布，不能另发第二份编辑事件。 */
@Slf4j
@RequiredArgsConstructor
public class EditFileToolExecutor implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final Differ differ;
    private final FileRecordManager fileRecordManager;
    private final int DEFAULT_AROUND_LINE = 3;

    @Override
    public @NonNull ToolExecuteResult execute(ToolExecution toolExecution) {
        String args = toolExecution.getArgs();
        try {
            EditFileRequest request = objectMapper.readValue(args, EditFileRequest.class);
            log.info("【ToolCall】 edit_file :{}", request.getPath());

            Workspace workspace = toolExecution.getWorkspace();
            EditOutcome outcome = applyEdit(request, workspace);

            if (!outcome.success()) {
                return ToolExecuteResult.err(outcome.error());
            }

            Serializable recordId = recordEdit(toolExecution, outcome);
            return ToolExecuteResult.success(objectMapper.writeValueAsString(outcome.toSummary()),
                    ToolResultType.NORMAL, buildMetadata(outcome, recordId));

        } catch (IOException e) {
            return ToolExecuteResult.err(e.getMessage());
        }
    }

    private EditOutcome applyEdit(EditFileRequest request, Workspace workspace) throws IOException {
        WorkspaceBridge bridge = workspace.bridge();
        Charset charset = workspace.runtimeEnvironment().charset();
        Path target = workspace.resolve(request.getPath());

        boolean existed = bridge.exists(target);
        String oldContent = existed ? bridge.readString(target, charset) : null;
        FileEditorResult editRes = FileEditor.edit(request, oldContent == null ? "" : oldContent, charset, DEFAULT_AROUND_LINE);
        if (!editRes.isSuccess()) {
            return EditOutcome.failure(editRes.getErrMsg());
        }

        Path parent = target.getParent();
        if (parent != null && !bridge.exists(parent)) {
            bridge.createDirectories(parent);
        }
        bridge.writeString(target, editRes.getData().newContent(), charset);

        return EditOutcome.success(request.getPath(), existed, oldContent,
                editRes.getData().newContent(), differ.diff(request.getPath(), oldContent == null ? "" : oldContent, editRes.getData().newContent()));
    }

    private Serializable recordEdit(ToolExecution toolExecution, EditOutcome outcome) {
        try {
            return fileRecordManager.record(toolExecution.getExecutionId(), toolExecution.getTurnId(),
                    FileRecord.builder()
                            .filePath(outcome.path())
                            .oldContent(outcome.existed() ? outcome.oldContent() : null)
                            .newContent(outcome.newContent())
                            .diff(outcome.diffResult().unifiedDiff())
                            .build());
        } catch (Exception e) {
            // 文件已经落盘；登记失败仍返回写入结果，但该编辑将无法回滚。
            log.warn("登记已落盘编辑失败: filePath={}, sessionId={}, reason={}",
                    outcome.path(), toolExecution.getExecutionId(), e.getMessage());
            return null;
        }
    }

    /** 全文不入事件，避免超出 SSE 帧预算；前端通过 recordId 查询记录。 */
    private Map<String, Object> buildMetadata(EditOutcome outcome, Serializable recordId) {
        Map<String, Object> fileEdit = new LinkedHashMap<>();
        fileEdit.put("filePath", outcome.path());
        if (recordId != null) {
            fileEdit.put("recordId", String.valueOf(recordId));
        }
        fileEdit.put("plusLines", outcome.plusLines());
        fileEdit.put("minusLines", outcome.minusLines());
        return Map.of("fileEdit", fileEdit);
    }

    /** 模型只收摘要，完整差异留给前端，避免重复传输全文并截断结果。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record EditSummary(String path, boolean created, Integer plusLines, Integer minusLines,
                               String diffError) {
    }

    private record EditOutcome(boolean success, String error, String path, boolean existed,
                               String oldContent, String newContent, DiffResult diffResult) {

        static EditOutcome success(String path, boolean existed, String oldContent,
                                   String newContent, DiffResult diffResult) {
            return new EditOutcome(true, null, path, existed, oldContent, newContent, diffResult);
        }

        static EditOutcome failure(String error) {
            return new EditOutcome(false, error, null, false, null, null, null);
        }

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
