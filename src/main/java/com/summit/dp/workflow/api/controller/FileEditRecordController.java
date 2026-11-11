package com.summit.dp.workflow.api.controller;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.workflow.application.filerecord.FileEditDiff;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 文件编辑记录的读侧接口：按需拉取差异文本。
 *
 * <p>差异不进 SSE 事件（全文会击穿单帧预算），前端只在需要时现取；记录由 {@code edit_file}
 * 落盘后登记，这里是唯一暴露口。</p>
 *
 * <p><b>没有「按轮次汇总」端点</b>：改动清单随轮次视图（{@code TurnViewVO.fileChanges}）下发，
 * 避免卡片挂载后再请求一次导致列表高度二次增长。本类只剩「打开某条记录的差异」。</p>
 *
 * <p><b>没有写接口</b>：撤销功能整体暂缓，本类只读。一个不能写文件的接口面，就不会在
 * 某个边界条件上写坏用户的文件。</p>
 */
@RestController
@RequestMapping("/a/file-edits")
@RequiredArgsConstructor
@Tag(name = "文件编辑记录", description = "差异查看")
public class FileEditRecordController {

    private final TurnFileEditSummaryService turnEdits;

    @Operation(summary = "读取一条编辑记录对应的累计差异")
    @GetMapping("/{executionId}/{recordId}")
    public Result<FileEditDiff> diff(@PathVariable String executionId, @PathVariable String recordId) {
        return Result.success(turnEdits.diffOf(executionId, recordId));
    }
}

