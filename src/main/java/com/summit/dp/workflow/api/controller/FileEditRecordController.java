package com.summit.dp.workflow.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.workflow.api.request.RollbackFilesRequest;
import com.summit.dp.workflow.application.filerecord.FileEditDiff;
import com.summit.dp.workflow.application.filerecord.FileRollbackPlan;
import com.summit.dp.workflow.application.filerecord.FileRollbackResult;
import com.summit.dp.workflow.application.filerecord.FileRollbackService;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;

/**
 * 文件编辑记录的接口：按需拉取差异文本、按基线回填。
 *
 * <p>差异不进 SSE 事件（全文会击穿单帧预算），前端只在需要时现取；记录由 {@code edit_file} /
 * {@code write_file} 落盘后登记，这里是唯一暴露口。</p>
 *
 * <p><b>没有「按轮次汇总」端点</b>：改动清单随轮次视图（{@code TurnViewVO.fileChanges}）下发，
 * 避免卡片挂载后再请求一次导致列表高度二次增长。</p>
 *
 * <p><b>回滚必然两段</b>：先 {@code preview} 拿到逐文件的门禁结论，再由用户确认后 {@code rollback}。
 * 不许合成一个「点了就写盘」的端点 —— 跳过的原因必须在他按下确认之前看到。</p>
 */
@Slf4j
@RestController
@RequestMapping("/a/file-edits")
@RequiredArgsConstructor
@Tag(name = "文件编辑记录", description = "差异查看与按基线回填")
public class FileEditRecordController {

    private final TurnFileEditSummaryService turnEdits;
    private final FileRollbackService rollbacks;
    private final TurnViewBroadcaster turnViews;

    @Operation(summary = "读取一条编辑记录对应的累计差异")
    @GetMapping("/{executionId}/{recordId}")
    public Result<FileEditDiff> diff(@PathVariable String executionId, @PathVariable String recordId) {
        return Result.success(turnEdits.diffOf(executionId, recordId));
    }

    /**
     * 该文件在整棵会话树里最新的一份差异：按文件名定位，不看轮次。
     *
     * <p>历史轮次的产物清单也能点开差异，但「当时改了什么」和「文件现在长什么样」是两件事，
     * 所以给的是两个入口，不是一个入口两种口径。</p>
     */
    @Operation(summary = "读取该文件最新的一份差异")
    @GetMapping("/latest/{sessionId}")
    public Result<FileEditDiff> latest(@PathVariable long sessionId, @RequestParam String path) {
        return Result.success(turnEdits.latestDiffOf(sessionId, path));
    }

    /**
     * 回滚预览：这次执行能回到哪些文件、哪些回不去以及为什么。
     *
     * <p>只读，绝不动盘。用户必须先看到这份清单，跳过项不能等到执行完才告诉他。</p>
     */
    @Operation(summary = "预览这次执行的文件回滚计划")
    @PostMapping("/rollback/preview/{executionId}")
    public Result<FileRollbackPlan> previewRollback(@PathVariable long executionId) {
        return Result.success(rollbacks.preview(executionId));
    }

    /**
     * 按基线回填确认过的文件。
     *
     * <p>计划会重新算一遍：预览到确认之间文件可能又被改过，拿旧计划写盘等于跳过末态门禁。</p>
     */
    @Operation(summary = "按基线回填确认过的文件")
    @PostMapping("/rollback/{executionId}")
    public Result<FileRollbackResult> rollback(@PathVariable long executionId,
                                               @RequestBody RollbackFilesRequest request) {
        FileRollbackResult result = rollbacks.rollback(executionId,
                request == null ? null : request.confirmedPaths());
        // 清单随轮次视图下发，回滚后重新推一帧：前端不必为一个标记再发请求，也拿不到假状态。
        this.rebroadcast(executionId);
        return Result.success(result);
    }

    /** 推送是旁路观测：推不出去不能把已经成功的回填报成失败。 */
    private void rebroadcast(long executionId) {
        try {
            this.turnViews.broadcastSnapshotForExecution(String.valueOf(executionId));
        } catch (RuntimeException failure) {
            log.warn("回滚后重推轮次视图失败: executionId={}, reason={}", executionId, failure.getMessage());
        }
    }
}
