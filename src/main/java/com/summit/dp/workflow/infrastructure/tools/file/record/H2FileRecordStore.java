package com.summit.dp.workflow.infrastructure.tools.file.record;

import com.summit.dp.execution.application.port.FileRecordMaintenance;
import com.summit.dp.workflow.infrastructure.tools.file.record.persistence.FileRecordMapper;
import com.summit.dp.workflow.infrastructure.tools.file.record.persistence.FileRecordPO;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;

import java.io.Serializable;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 记录落 H2 的实现：库表存元数据与差异，基线正文落文件系统，库内只留绝对路径。
 *
 * <p><b>相对内存实现的唯一目的就是「活过重启」</b>：此前记录只在进程内存里，
 * 后端一重启，历史会话的改动清单就重建不出来。重建算法（基线 + 顺序重放）一个字没动，
 * 换的只是存放地点 —— 所以这里不重新设计任何语义。</p>
 *
 * <p><b>三条不能破的约束</b>：</p>
 * <ol>
 *   <li>顺序由库承担：读侧固定 {@code ORDER BY seq}，服务层不排序；</li>
 *   <li>「本轮是否已改过该文件」用计数查询判定，<b>不能</b>为了省事去 {@link #listByExecution}
 *       再过滤 —— 那会把每条基线文件都读进内存，正是先前 OOM 的形态；</li>
 *   <li>基线读不出来时整条跳过而不是当成空文件：编造出来的差异比缺一条记录更糟。</li>
 * </ol>
 *
 * <p><b>过期回收</b>：{@link #purgeBefore} 整条回收（行 + 基线文件）。刻意不单独删基线文件 ——
 * 只删文件会留下「baseline_path 悬空」的记录，读回来变成 {@code baseline = null}，
 * 而 {@code null} 在这条链路上表示「本轮新建文件」，于是历史差异会被算成「整份文件都是新增」，
 * 一路骗到界面上。</p>
 */
@Slf4j
@RequiredArgsConstructor
public class H2FileRecordStore implements FileRecordStore, FileRecordMaintenance {

    private final FileRecordMapper mapper;
    private final BaselineFileStore baselines;

    @Override
    public FileRecord put(@NonNull FileRecord record) {
        String executionId = String.valueOf(record.executionId());
        String id = record.id() == null ? String.valueOf(this.generateId()) : String.valueOf(record.id());
        String filePath = record.filePath();
        int version = record.version() != null ? record.version()
                : this.mapper.maxVersion(executionId, filePath) + 1;
        // 基线先落盘再登记：登记成功却引用不到基线，比重放失败更隐蔽。
        String baselinePath = record.baseline() == null ? null
                : this.baselines.write(executionId, id, record.baseline());

        FileRecordPO po = new FileRecordPO();
        po.setId(id);
        po.setExecutionId(executionId);
        po.setTurnId(record.turnId() == null ? null : String.valueOf(record.turnId()));
        po.setVersion(version);
        po.setFilePath(filePath);
        po.setBaselinePath(baselinePath);
        po.setDiff(record.diff());
        po.setPlusLines(record.plusLines());
        po.setMinusLines(record.minusLines());
        po.setCreateAt(record.createAt() == null ? Instant.now() : record.createAt());
        this.mapper.insert(po);

        return FileRecord.builder()
                .id(id).executionId(record.executionId()).turnId(record.turnId())
                .version(version).filePath(filePath).baseline(record.baseline())
                .diff(record.diff()).plusLines(record.plusLines()).minusLines(record.minusLines())
                .createAt(po.getCreateAt())
                .build();
    }

    @Override
    public Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        FileRecordPO po = this.mapper.selectByExecutionAndId(String.valueOf(executionId), String.valueOf(recordId));
        return po == null ? Optional.empty() : Optional.of(this.toRecord(po));
    }

    @Override
    public void clearByExecutionId(@NonNull Serializable executionId) {
        String key = String.valueOf(executionId);
        for (FileRecordPO po : this.mapper.listByExecution(key)) {
            this.baselines.delete(po.getBaselinePath());
        }
        this.mapper.delete(new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<FileRecordPO>()
                .eq("execution_id", key));
        this.baselines.deleteExecution(key);
    }

    @Override
    public List<FileRecord> listByExecution(@NonNull Serializable executionId) {
        List<FileRecordPO> rows = this.mapper.listByExecution(String.valueOf(executionId));
        List<FileRecord> records = new ArrayList<>(rows.size());
        for (FileRecordPO row : rows) {
            records.add(this.toRecord(row));
        }
        return records;
    }

    @Override
    public boolean existsForTurn(@NonNull Serializable executionId, Serializable turnId, @NonNull String filePath) {
        if (turnId == null) {
            return false;
        }
        return this.mapper.countByTurnAndFile(String.valueOf(executionId), String.valueOf(turnId), filePath) > 0;
    }

    /**
     * 回收 {@code cutoff} 之前建立的记录（连同基线文件）。
     *
     * @return 实际删除的记录条数
     */
    @Override
    public int purgeBefore(@NonNull Instant cutoff) {
        List<FileRecordPO> expired = this.mapper.listCreatedBefore(cutoff);
        int deleted = 0;
        for (FileRecordPO po : expired) {
            // 先删行：行没了，文件最多是个孤儿；反过来会留下指向空路径的活记录。
            if (this.mapper.deleteByIdValue(po.getId()) > 0) {
                deleted++;
            }
            this.baselines.delete(po.getBaselinePath());
        }
        return deleted;
    }

    /**
     * 清空全部记录：仅测试与本地重置使用，生产不做全表删除。
     */
    @Override
    public void clear() {
        for (FileRecordPO po : this.mapper.selectList(null)) {
            this.baselines.delete(po.getBaselinePath());
        }
        this.mapper.delete(new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<>());
    }

    /** 库行 → 领域记录：基线按需从文件读回，读不到就当这条没有基线（不编造空文件）。 */
    private FileRecord toRecord(FileRecordPO po) {
        return FileRecord.builder()
                .id(po.getId()).executionId(po.getExecutionId()).turnId(po.getTurnId())
                .version(po.getVersion()).filePath(po.getFilePath())
                .baseline(this.baselines.read(po.getBaselinePath()).orElse(null))
                .diff(po.getDiff()).plusLines(orZero(po.getPlusLines())).minusLines(orZero(po.getMinusLines()))
                .createAt(po.getCreateAt())
                .build();
    }

    private static int orZero(Integer value) {
        return value == null ? 0 : value;
    }
}
