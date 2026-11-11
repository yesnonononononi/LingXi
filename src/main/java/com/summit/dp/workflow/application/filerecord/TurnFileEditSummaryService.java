package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.block.TurnFileChangeVO;
import com.summit.dp.turn.application.port.TurnFileChangeQuery;
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
 * <p><b>契约</b>：清单只给增删行数与定位，差异正文不进视图（会击穿单帧预算），由预览面板现取。
 * 「这一轮改了什么」与「这个文件最新长什么样」是两件事：前者由 {@link #diffOf} 按记录重放，
 * 后者由 {@link #latestDiffOf} 按文件名找最新记录。任何一轮只要有可重放的记录就能点开，
 * 不再只给最新轮次开绿灯。</p>
 *
 * <p><b>它同时是 {@link TurnFileChangeQuery} 的实现</b>：轮次视图装配只要「这轮改了哪些文件、
 * 多少行」，不该依赖本类的记录与重放细节。</p>
 */
@Service
@RequiredArgsConstructor
public class TurnFileEditSummaryService implements TurnFileChangeQuery {

    /** 差异文本上限：与前端预览面板对齐，超出部分截断并显式标记。 */
    private static final int MAX_DIFF_CHARS = 256 * 1024;

    private final FileRecordManager records;
    private final ChatTurnRepository turns;
    private final FileEditSceneScope scenes;
    private final Differ differ;

    /**
     * 汇总一轮内所有文件的净改动。
     *
     * @param turnId 业务轮次 ID
     * @return 按文件首次出现顺序排列的净改动；轮次不存在或尚未绑定执行时返回空列表
     */
    @Override
    public List<TurnFileChangeVO> summarize(long turnId) {
        ChatTurn turn = turns.findById(turnId).orElse(null);
        if (turn == null || turn.getExecutionId() == null) {
            return List.of();
        }
        String executionKey = String.valueOf(turn.getExecutionId());
        Map<String, List<FileRecord>> byFile = this.groupByFile(executionKey, String.valueOf(turnId));
        List<TurnFileChangeVO> summary = new ArrayList<>(byFile.size());
        byFile.forEach((path, fileRecords) ->
                summary.add(this.summarizeFile(executionKey, path, fileRecords)));
        return summary;
    }

    /**
     * 一条记录的差异视图：查记录、重建差异、按上限截断。
     *
     * <p>截断与「记录不存在」「基线过期」都是业务口径，属于应用层，不该散在接口层里 ——
     * 接口层只做转发。</p>
     *
     * @throws ClientException 记录不存在，或基线已过期导致差异重建不出来
     */
    public FileEditDiff diffOf(String executionId, String recordId) {
        FileRecord target = records.getRecord(executionId, recordId)
                .orElseThrow(() -> new ClientException("文件编辑记录不存在或已失效"));
        return this.toDiff(target, this.requireDiff(target));
    }

    /**
     * 这个文件在整棵会话树里最新的一份差异。
     *
     * <p>按文件名定位、不认轮次：从任何一轮的产物清单点开「最新改动」，看到的都该是这个文件
     * 此刻最后一次改动，而不是那条记录所属轮次的中间状态。</p>
     *
     * @throws ClientException 文件没有编辑记录，或作用域内的记录已过期
     */
    public FileEditDiff latestDiffOf(long sessionId, String filePath) {
        List<String> turnIds = scenes.resolveSceneTurnIds(sessionId);
        FileRecord target = records.findLatestRecord(filePath, turnIds)
                .orElseThrow(() -> new ClientException("这个文件还没有编辑记录，看不到差异"));
        return this.toDiff(target, this.requireDiff(target));
    }

    /** 差异给不出来时一律抛业务异常：空串会被前端当成功渲染成一份空差异。 */
    private String requireDiff(FileRecord target) {
        return this.rebuildUpTo(target)
                .orElseThrow(() -> new ClientException("这条编辑记录的基线已过期，差异无法重建"));
    }

    /** 截断口径只有一处：超过上限切掉并显式标记，同时带上记录定位供前端比对。 */
    private FileEditDiff toDiff(FileRecord target, String diff) {
        boolean truncated = diff.length() > MAX_DIFF_CHARS;
        return new FileEditDiff(target.filePath(),
                truncated ? diff.substring(0, MAX_DIFF_CHARS) : diff, truncated,
                String.valueOf(target.executionId()), String.valueOf(target.id()));
    }

    /** 从基线重放到目标记录为止；目标不在同一轮同一文件时自然重放不出东西。 */
    private Optional<String> rebuildUpTo(FileRecord target) {
        // 只重放到目标记录为止：它表达的是「这条记录当时的文件状态」，不是本轮最终状态。
        // 取的是「这一轮 + 这个文件」的窄查询，不是整执行全量 —— 后者会连其它轮次的基线一起读。
        List<FileRecord> upToTarget = new ArrayList<>();
        for (FileRecord record : records.listTurnRecords(target.executionId(), target.turnId())) {
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
     * <p>重放不出来时不编数字：行数给 0、差异标记为不可用。宁可显示「算不出来」，
     * 也不要把逐次累加值伪装成净改动 —— 那正是这条链路最容易骗人的地方。</p>
     */
    private TurnFileChangeVO summarizeFile(String executionKey, String path, List<FileRecord> fileRecords) {
        FileRecord first = fileRecords.getFirst();
        String baseline = first.baseline();
        Optional<String> finalContent = this.replay(fileRecords);
        DiffResult combined = finalContent.isEmpty() ? null
                : differ.diff(path, baseline == null ? "" : baseline, finalContent.get());
        int plusLines = combined == null ? 0 : combined.plusLines();
        int minusLines = combined == null ? 0 : combined.minusLines();
        return new TurnFileChangeVO(path, plusLines, minusLines, fileRecords.size(),
                this.createdInTurn(first), executionKey, String.valueOf(fileRecords.getLast().id()),
                combined != null);
    }

    /**
     * 本轮是否新建了这个文件。
     *
     * <p>首条记录没有基线有两种原因：本轮开始时文件不存在，或者基线已被回收 ——
     * 后者不能标成「新建」，那是我们自己把数据弄丢了，不是用户的改动。</p>
     */
    private boolean createdInTurn(FileRecord first) {
        return first.baseline() == null && !first.baselineMissing();
    }

    /** 重放该文件各次差异并生成「基线 → 末态」的统一差异（差异视图专用）。 */
    private Optional<String> rebuildDiff(String path, List<FileRecord> fileRecords) {
        if (fileRecords.isEmpty()) {
            return Optional.empty();
        }
        String baseline = fileRecords.getFirst().baseline();
        Optional<String> finalContent = this.replay(fileRecords);
        if (finalContent.isEmpty()) {
            return Optional.empty();
        }
        DiffResult result = differ.diff(path, baseline == null ? "" : baseline, finalContent.get());
        return result.isSuccess() ? Optional.of(result.unifiedDiff()) : Optional.empty();
    }

    /** 基线丢了就不重放：拿空串顶上会把整份文件算成新增。 */
    private Optional<String> replay(List<FileRecord> fileRecords) {
        FileRecord first = fileRecords.getFirst();
        if (first.baseline() == null && first.baselineMissing()) {
            return Optional.empty();
        }
        return UnifiedDiffReplayer.replay(first.baseline(),
                fileRecords.stream().map(FileRecord::diff).toList());
    }
}
