package com.summit.dp.workflow.api.controller;

import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.workspace.WorkspaceResolver;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 文件编辑记录的读侧接口：按需拉取差异文本、撤销单次编辑。
 *
 * <p>差异不进 SSE 事件（全文会击穿单帧预算），前端只在需要时按 {@code executionId + recordId}
 * 现取；记录本身由 {@code edit_file} 落盘后登记，这里是唯一暴露口。</p>
 */
@RestController
@RequestMapping("/a/file-edits")
@RequiredArgsConstructor
@Tag(name = "文件编辑记录", description = "差异查看与撤销")
public class FileEditRecordController {

    /** 与前端预览面板的 256KB 文本上限对齐：超出部分截断并显式标记，不静默丢内容。 */
    private static final int MAX_DIFF_CHARS = 256 * 1024;

    private final FileRecordManager records;
    private final SessionService sessions;
    private final WorkspaceService workspaces;
    private final WorkspaceConverter workspaceConverter;
    private final WorkspaceResolver workspaceResolver;
    private final TurnFileEditSummaryService turnEdits;
    private final ChatTurnRepository turns;

    @Operation(summary = "读取一次文件编辑的统一差异")
    @GetMapping("/{executionId}/{recordId}")
    public Result<FileEditDiff> diff(@PathVariable String executionId, @PathVariable String recordId) {
        FileRecord record = this.requireRecord(executionId, recordId);
        String diff = record.diff() == null ? "" : record.diff();
        boolean truncated = diff.length() > MAX_DIFF_CHARS;
        return Result.success(new FileEditDiff(record.filePath(),
                truncated ? diff.substring(0, MAX_DIFF_CHARS) : diff, truncated));
    }

    /**
     * 撤销一次编辑并还原文件。
     *
     * <p>必须按会话重建同一个工作空间再还原：直接把内容写回宿主目录会绕过沙箱，
     * 让「回滚」变成比原编辑更危险的越界写。</p>
     */
    @Operation(summary = "撤销一次文件编辑")
    @PostMapping("/{executionId}/{recordId}/reject")
    public Result<Boolean> reject(@PathVariable String executionId, @PathVariable String recordId,
                                  @RequestParam Long sessionId) {
        FileRecord record = this.requireRecord(executionId, recordId);
        return Result.success(records.reject(executionId, record.id(), this.resolveWorkspace(sessionId)));
    }

    @Operation(summary = "汇总一轮内所有文件的净改动")
    @GetMapping("/turns/{turnId}/summary")
    public Result<List<TurnFileEditSummaryService.TurnFileEdit>> turnSummary(@PathVariable Long turnId) {
        return Result.success(turnEdits.summarize(turnId));
    }

    /**
     * 撤销一整轮的全部文件改动。
     *
     * <p>逐条撤销会漏掉顺序约束（同文件必须逆序还原），所以这里走
     * {@code rejectTurn} 一次性把本轮记录按版本逆序还原 —— 顺带也让整轮撤销成为原子语义：
     * 要么全部还原，要么把冲突如实报出来，不留「撤了一半」的错觉。</p>
     *
     * <p><b>会话取自轮次本身，不接受客户端传参</b>：还原必须落在原工作空间里，
     * 由调用方指定 {@code sessionId} 等于允许「把 A 会话的文件还原到 B 的工作空间」，
     * 这种写错目标目录的越界还原比不还原更糟。</p>
     */
    @Operation(summary = "撤销一轮内的全部文件改动")
    @PostMapping("/turns/{turnId}/reject")
    public Result<Integer> rejectTurn(@PathVariable Long turnId) {
        ChatTurn turn = turns.findById(turnId).orElse(null);
        if (turn == null || turn.getExecutionId() == null || turn.getSessionId() == null) {
            throw new ClientException("轮次不存在或尚未绑定执行，无法撤销文件改动");
        }
        return Result.success(records.rejectTurn(String.valueOf(turn.getExecutionId()),
                String.valueOf(turnId), this.resolveWorkspace(turn.getSessionId())));
    }

    private FileRecord requireRecord(String executionId, String recordId) {
        return records.getRecord(executionId, recordId)
                .orElseThrow(() -> new ClientException("文件编辑记录不存在或已失效"));
    }

    private Workspace resolveWorkspace(Long sessionId) {
        SessionVO session = sessions.findById(sessionId).getData();
        if (session == null) {
            throw new ClientException("会话不存在，无法撤销文件编辑");
        }
        Long workspaceId = session.getWorkspaceId();
        WorkspaceVO workspace = workspaceId == null ? null : workspaces.findById(workspaceId).getData();
        WorkspaceSpec spec = workspaceConverter.toSpec(workspace, workspaceConverter.resolveType());
        if (spec == null) {
            throw new ClientException("会话未绑定工作空间，无法撤销文件编辑");
        }
        return workspaceResolver.resolve(spec);
    }

    /** 差异文本与截断标记；路径供前端校验记录与当前打开的文件一致。 */
    public record FileEditDiff(String filePath, String unifiedDiff, boolean truncated) {
    }
}
