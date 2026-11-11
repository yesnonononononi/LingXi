package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.UnifiedDiffReplayer;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * 单轮文件改动汇总：同一文件在本轮内的多次编辑合并成一条「净改动」。
 *
 * <p><b>为什么必须重算而不是累加</b>：记录里的 {@code +N/−M} 是每次编辑的独立统计，
 * 同一行被改两次就会记成两次增删。正确做法是把各次差异依次重放回基线得到末态，
 * 再与基线做一次完整差异 —— 那才是这个文件真实的净变化量。</p>
 *
 * <p><b>契约</b>：只有最新轮次带差异正文，历史轮次只给增删行数。历史 diff 既没有展示位，
 * 也没必要让它留在热路径上。</p>
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
        Map<String, List<FileRecord>> byFile = this.groupByFile(executionKey, String.valueOf(turnId));
        boolean latest = this.isLatestTurnOfSession(turn);
        List<TurnFileEdit> summary = new ArrayList<>(byFile.size());
        byFile.forEach((path, fileRecords) ->
                summary.add(this.summarizeFile(executionKey, path, fileRecords, latest)));
        return summary;
    }

    /**
     * 某条记录对应的累计差异：基线 → 该条为止的末态。
     *
     * <p>按记录标识取（而不是按轮次取）是为了让「点开某一行」在历史轮次里也成立 ——
     * 即便界面当前只在最新轮次暴露入口，接口本身不该是个只对最新轮次才有效的东西。</p>
     *
     * @return 统一差异文本；记录不存在或差异重放失败时为空
     */
    public Optional<String> accumulatedDiff(String executionId, String recordId) {
        FileRecord target = records.getRecord(executionId, recordId).orElse(null);
        if (target == null) {
            return Optional.empty();
        }
        // 只重放到目标记录为止：它表达的是「这条记录当时的文件状态」，不是本轮最终状态。
        // 取的是「这一轮 + 这个文件」的窄查询，不是整执行全量 —— 后者会连其它轮次的基线一起读。
        List<FileRecord> upToTarget = new ArrayList<>();
        for (FileRecord record : records.listTurnRecords(executionId, target.turnId())) {
            if (!Objects.equals(record.filePath(), target.filePath())) {
                continue;
            }
            upToTarget.add(record);
            if (Objects.equals(record.id(), target.id())) {
                break;
            }
        }
        return this.rebuildDiff(target.filePath(), upToTarget);
    }

    /** 按文件分组，跳过缺少路径的记录；行只来自本轮，故不再按轮次过滤。 */
    private Map<String, List<FileRecord>> groupByFile(String executionKey, String turnKey) {
        Map<String, List<FileRecord>> byFile = new LinkedHashMap<>();
        for (FileRecord record : records.listTurnRecords(executionKey, turnKey)) {
            if (record.filePath() == null) {
                continue;
            }
            byFile.computeIfAbsent(record.filePath(), path -> new ArrayList<>()).add(record);
        }
        return byFile;
    }

    /**
     * 单个文件的净改动：基线 → 重放各次差异后的末态。
     *
     * <p>重放失败时不编数字：行数给 0、差异给空。宁可显示「算不出来」，
     * 也不要把逐次累加值伪装成净改动 —— 那正是这条链路最容易骗人的地方。</p>
     */
    private TurnFileEdit summarizeFile(String executionKey, String path, List<FileRecord> fileRecords,
                                       boolean includeDiff) {
        String baseline = fileRecords.getFirst().baseline();
        Optional<String> rebuilt = this.rebuildDiff(path, fileRecords);
        DiffResult combined = rebuilt.isEmpty() ? null : differ.diff(path,
                baseline == null ? "" : baseline, this.replayOrEmpty(baseline, fileRecords));
        int plusLines = combined == null ? 0 : combined.plusLines();
        int minusLines = combined == null ? 0 : combined.minusLines();
        return new TurnFileEdit(path, plusLines, minusLines, fileRecords.size(), baseline == null,
                executionKey, String.valueOf(fileRecords.getLast().id()),
                includeDiff ? rebuilt.orElse(null) : null);
    }

    /** 重放该文件各次差异并生成「基线 → 末态」的统一差异。 */
    private Optional<String> rebuildDiff(String path, List<FileRecord> fileRecords) {
        if (fileRecords.isEmpty()) {
            return Optional.empty();
        }
        String baseline = fileRecords.getFirst().baseline();
        Optional<String> finalContent = this.replay(baseline, fileRecords);
        if (finalContent.isEmpty()) {
            return Optional.empty();
        }
        DiffResult result = differ.diff(path, baseline == null ? "" : baseline, finalContent.get());
        return result.isSuccess() ? Optional.of(result.unifiedDiff()) : Optional.empty();
    }

    /** 末态内容；重放失败时退回空串（配合上面的「不编数字」口径）。 */
    private String replayOrEmpty(String baseline, List<FileRecord> fileRecords) {
        return this.replay(baseline, fileRecords).orElse("");
    }

    private Optional<String> replay(String baseline, List<FileRecord> fileRecords) {
        return UnifiedDiffReplayer.replay(baseline, fileRecords.stream().map(FileRecord::diff).toList());
    }

    /**
     * 该轮次是否为所在会话的最新一轮。
     *
     * <p>用 {@code findLatest} 而不是「看有没有更大的 executionId」：仓储已经提供了
     * 「取最新一轮」的语义，不该在这里再发明一套。</p>
     */
    private boolean isLatestTurnOfSession(ChatTurn turn) {
        if (turn.getSessionId() == null) {
            return false;
        }
        List<ChatTurn> latest = turns.findLatest(turn.getSessionId(), null, 1);
        return !latest.isEmpty() && Objects.equals(latest.getFirst().getId(), turn.getId());
    }

    /**
     * 一个文件在本轮内的净改动。
     *
     * @param filePath    文件绝对路径（与文件预览入参同形）
     * @param plusLines   净新增行数
     * @param minusLines  净删除行数
     * @param edits       本轮编辑次数（前端用它提示「合并了 N 次编辑」）
     * @param created     本文件是否由本轮新建
     * @param executionId 执行标识，打开差异视图要用
     * @param recordId    末条记录标识，打开差异视图要用
     * @param diff        统一差异正文；<b>仅最新轮次有值</b>，历史轮次为 {@code null}
     */
    public record TurnFileEdit(String filePath, int plusLines, int minusLines, int edits,
                              boolean created, String executionId, String recordId, String diff) {
    }
}
