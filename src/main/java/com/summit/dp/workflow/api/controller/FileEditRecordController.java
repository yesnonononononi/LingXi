package com.summit.dp.workflow.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/**
 * 文件编辑记录的读侧接口：按需拉取差异文本、按轮次取改动清单。
 *
 * <p>差异不进 SSE 事件（全文会击穿单帧预算），前端只在需要时现取；记录由 {@code edit_file}
 * 落盘后登记，这里是唯一暴露口。</p>
 *
 * <p><b>没有写接口</b>：撤销功能整体暂缓，本类只读。一个不能写文件的接口面，就不会在
 * 某个边界条件上写坏用户的文件。</p>
 */
@RestController
@RequestMapping("/a/file-edits")
@RequiredArgsConstructor
@Tag(name = "文件编辑记录", description = "差异查看与改动清单")
public class FileEditRecordController {

    /** 与前端预览面板的 256KB 文本上限对齐：超出部分截断并显式标记，不静默丢内容。 */
    private static final int MAX_DIFF_CHARS = 256 * 1024;

    private final FileRecordManager records;
    private final TurnFileEditSummaryService turnEdits;

    @Operation(summary = "读取一条编辑记录对应的累计差异")
    @GetMapping("/{executionId}/{recordId}")
    public Result<FileEditDiff> diff(@PathVariable String executionId, @PathVariable String recordId) {
        FileRecord record = this.requireRecord(executionId, recordId);
        String diff = turnEdits.accumulatedDiff(executionId, recordId).orElse("");
        boolean truncated = diff.length() > MAX_DIFF_CHARS;
        return Result.success(new FileEditDiff(record.filePath(),
                truncated ? diff.substring(0, MAX_DIFF_CHARS) : diff, truncated));
    }

    @Operation(summary = "汇总一轮内所有文件的净改动")
    @GetMapping("/turns/{turnId}/summary")
    public Result<List<TurnFileEditSummaryService.TurnFileEdit>> turnSummary(@PathVariable Long turnId) {
        return Result.success(turnEdits.summarize(turnId));
    }

    private FileRecord requireRecord(String executionId, String recordId) {
        return records.getRecord(executionId, recordId)
                .orElseThrow(() -> new ClientException("文件编辑记录不存在或已失效"));
    }

    /** 差异文本与截断标记；路径供前端校验记录与当前打开的文件一致。 */
    public record FileEditDiff(String filePath, String unifiedDiff, boolean truncated) {
    }
}

