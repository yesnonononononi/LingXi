package com.summit.dp.workflow.infrastructure.tools.file;

import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.workflow.infrastructure.tools.file.record.*;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.Serializable;

/**
 * 已落盘改动的登记与广播，编辑类工具共用。
 *
 * <p>顺序固定：先落盘、再登记。反过来会把没写进文件的内容当成可回滚记录。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class FileEditRecorder {

    private final Differ differ;
    private final FileRecordManager fileRecordManager;

    public FileEditReport record(ToolExecution toolExecution, FileMutation mutation) {
        DiffResult diff = differ.diff(mutation.diffName(),
                mutation.oldContent() == null ? "" : mutation.oldContent(), mutation.newContent());
        return new FileEditReport(mutation, diff, register(toolExecution, mutation, diff));
    }

    private Serializable register(ToolExecution toolExecution, FileMutation mutation, DiffResult diff) {
        try {
            return fileRecordManager.record(toolExecution.getExecutionId(), businessTurnId(toolExecution),
                    FileRecord.builder()
                            .filePath(mutation.filePath())
                            // 基线只对分段起点有效，是否保留由登记器判定；这里如实给出「改之前是什么」。
                            .baseline(mutation.oldContent())
                            .diff(diff == null ? null : diff.unifiedDiff())
                            .plusLines(diff == null ? 0 : diff.plusLines())
                            .minusLines(diff == null ? 0 : diff.minusLines())
                            // 改完之后的摘要：登记下一条时靠它发现链被工具外的修改打断。
                            .contentDigest(ContentDigest.compute(mutation.newContent()))
                            .build());
        } catch (Exception e) {
            // 文件已经落盘；登记失败仍返回写入结果，只是这一改动事后查不到差异。
            log.warn("登记已落盘编辑失败: filePath={}, executionId={}, reason={}",
                    mutation.filePath(), toolExecution.getExecutionId(), e.getMessage());
            return null;
        }
    }

    /**
     * 取本轮的业务轮次 ID（{@code chat_turn} 主键）。
     *
     * <p><b>不能用 {@code toolExecution.getTurnId()}</b>：框架 {@code DefaultToolExecutionManager}
     * 把它赋成了 {@code command.executionId()}，那是执行标识而不是轮次主键。用它当轮次，
     * 轮次汇总与整轮撤销一条也匹配不到 —— 清单恒空、撤销恒 0，且不会报错。</p>
     */
    private String businessTurnId(ToolExecution toolExecution) {
        Object turnId = toolExecution.getEventMetaData().get(ExecutionEventMetadata.TURN_ID);
        return turnId == null ? null : turnId.toString();
    }
}