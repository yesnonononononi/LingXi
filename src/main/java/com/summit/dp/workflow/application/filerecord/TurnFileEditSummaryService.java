package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 单轮文件改动汇总：同一文件在本轮内的多次编辑合并成一条「净改动」。
 *
 * <p><b>为什么必须重算而不是累加</b>：工具摘要里的 {@code +N/−M} 是每次编辑的独立统计，
 * 同一行被改两次就会记成两次增删。只有取本轮<em>首条记录的旧内容</em>与<em>末条记录的新内容</em>
 * 重新做一次差异，才是这个文件真实的净变化量。</p>
 *
 * <p>记录来自 {@code FileRecordManager}；轮次到执行的映射来自 {@code chat_turn.execution_id}。
 * 两侧的轮次标识类型不同（业务轮次是数值主键，记录侧是框架传下来的字符串），比较前必须归一化。</p>
 */
@Service
@RequiredArgsConstructor
public class TurnFileEditSummaryService {

    private final FileRecordManager records;
    private final ChatTurnRepository turns;
    private final Differ differ;

    /**
     * 汇总一轮内所有文件的净改动。
     *
     * @param turnId 业务轮次 ID
     * @return 按文件首次出现顺序排列的净改动；轮次不存在或尚未绑定执行时返回空列表
     */
    public List<TurnFileEdit> summarize(long turnId) {
        ChatTurn turn = turns.findById(turnId).orElse(null);
        if (turn == null || turn.getExecutionId() == null) {
            return List.of();
        }
        String executionKey = String.valueOf(turn.getExecutionId());
        String turnKey = String.valueOf(turnId);
        Map<String, List<FileRecord>> byFile = new LinkedHashMap<>();
        for (FileRecord record : records.listRecords(executionKey)) {
            // 已撤销的编辑在文件上已不存在，继续列出来会让清单说谎。
            if (record.state() == FileRecord.State.REJECTED) {
                continue;
            }
            if (!Objects.equals(record.turnId(), turnKey)) {
                continue;
            }
            byFile.computeIfAbsent(record.filePath(), path -> new ArrayList<>()).add(record);
        }
        List<TurnFileEdit> summary = new ArrayList<>(byFile.size());
        byFile.forEach((path, fileRecords) -> summary.add(this.summarizeFile(executionKey, path, fileRecords)));
        return summary;
    }

    /**
     * 单个文件的净改动：首条旧内容 → 末条新内容。
     *
     * <p>这里不再按版本重排：{@code FileRecordStore.listByExecution} 的契约就是保持插入顺序，
     * 而同一文件的版本正是插入时递增分配的，重排等于把存储契约重写一遍还要给它写测试。
     * 顺序责任留在存储侧 —— 将来换成持久化实现，{@code ORDER BY} 也该写在那边。</p>
     */
    private TurnFileEdit summarizeFile(String executionKey, String path, List<FileRecord> fileRecords) {
        FileRecord first = fileRecords.getFirst();
        FileRecord last = fileRecords.getLast();
        // 记录没有旧内容表示本文件是本轮新建的，净改动就是整份新内容。
        String oldContent = first.oldContent() == null ? "" : first.oldContent();
        DiffResult diff = differ.diff(path, oldContent, last.newContent());
        // 标识由存储分配，取出即非空；这里不做「空的标识怎么显示」——那种情况不存在。
        return new TurnFileEdit(path, diff.plusLines(), diff.minusLines(), fileRecords.size(),
                first.oldContent() == null, executionKey, String.valueOf(last.id()));
    }

    /**
     * 一个文件在本轮内的净改动。
     *
     * @param filePath     文件绝对路径（与文件预览入参同形）
     * @param plusLines    净新增行数
     * @param minusLines   净删除行数
     * @param edits        本轮编辑次数（前端用它提示「合并了 N 次编辑」）
     * @param created      本文件是否由本轮新建
     * @param executionId  执行标识，打开差异视图要用
     * @param recordId     末条记录标识，打开差异视图要用
     */
    public record TurnFileEdit(String filePath, int plusLines, int minusLines, int edits,
                              boolean created, String executionId, String recordId) {
    }
}
