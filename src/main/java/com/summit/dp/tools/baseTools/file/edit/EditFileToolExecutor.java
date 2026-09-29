package com.summit.dp.tools.baseTools.file.edit;


import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.*;
import com.summit.dp.tools.baseTools.file.record.DiffResult;
import com.summit.dp.tools.baseTools.file.record.Differ;
import com.summit.dp.tools.baseTools.file.record.FileRecord;
import com.summit.dp.tools.baseTools.file.record.FileRecordManager;
import com.summit.dp.tools.baseTools.arguments.EditFileRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.jspecify.annotations.NonNull;
import java.io.IOException;
import java.io.Serializable;
import java.nio.charset.Charset;
import java.nio.file.Path;


/**
 * Edits a file inside the workspace. The new content is written to disk
 * FIRST; the applied edit is then recorded as a pending {@link FileRecord} so
 * the user can accept (keep) or reject (restore) it afterwards.
 */
@Slf4j
@RequiredArgsConstructor
public class EditFileToolExecutor implements ToolExecutor {
    private final ObjectMapper objectMapper;
    private final Differ differ;
    private final FileRecordManager fileRecordManager;
    private final RuntimeEventPublisher runtimeEventPublisher;
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
            publishEditEvent(toolExecution, outcome, recordId);
            return ToolExecuteResult.success(objectMapper.writeValueAsString(outcome.toSummary()));

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
            // The edit itself is already on disk; failing to journal it must not
            // fail the tool call, but the edit then cannot be rejected anymore.
            log.warn("failed to record applied edit on {} for session {}: {}",
                    outcome.path(), toolExecution.getExecutionId(), e.getMessage());
            return null;
        }
    }

    private void publishEditEvent(ToolExecution toolExecution, EditOutcome outcome, Serializable recordId) {
        runtimeEventPublisher.onApplicationEvent(FileEditEvent.builder()
                .recordId(recordId)
                .turnId(toolExecution.getTurnId())
                .filePath(outcome.path())
                .oldContent(outcome.oldContent())
                .newContent(outcome.newContent())
                .plusLines(outcome.plusLines())
                .minusLines(outcome.minusLines())
                .build());
    }

    /**
     * What the model gets back: only "what the file looks like now", never the diff itself.
     * The full unified diff is journaled and pushed to the front-end only — echoing it back
     * means paying for the whole file twice, and it always blows past edit_file's max-output,
     * leaving the model with a half-truncated JSON.
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record EditSummary(String path, boolean created, Integer plusLines, Integer minusLines,
                               String diffError) {
    }

    /**
     * Result of one edit application: what was written and what it replaced.
     *
     * @param existed    whether the file existed before this edit (false = created)
     * @param oldContent content before the edit, {@code null} when created
     */
    private record EditOutcome(boolean success, String error, String path, boolean existed,
                               String oldContent, String newContent, DiffResult diffResult) {

        static EditOutcome success(String path, boolean existed, String oldContent,
                                   String newContent, DiffResult diffResult) {
            return new EditOutcome(true, null, path, existed, oldContent, newContent, diffResult);
        }

        static EditOutcome failure(String error) {
            return new EditOutcome(false, error, null, false, null, null, null);
        }

        /** Whether this call created the file rather than modifying an existing one. */
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
