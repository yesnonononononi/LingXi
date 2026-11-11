package com.summit.dp.workflow.infrastructure.tools.file.record;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.summit.dp.execution.application.port.FileRecordMaintenance;
import com.summit.dp.workflow.infrastructure.tools.file.record.persistence.FileRecordMapper;
import com.summit.dp.workflow.infrastructure.tools.file.record.persistence.FileRecordPO;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.Serializable;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 记录落 H2：库表存元数据与差异，基线正文落文件系统、库内只留绝对路径。
 *
 * <p>换存储只为「活过重启」，重建算法一个字没动。</p>
 *
 * <p>三条约束：顺序由库承担（{@code ORDER BY seq}）；存在性判定必须走计数查询，不能 list 全量
 * 再过滤（那会把每条基线读进内存）；基线读不出来时整条跳过，不当成空文件。</p>
 */
@Slf4j
@RequiredArgsConstructor
@Component
public class H2FileRecordStore implements FileRecordStore, FileRecordMaintenance {

    private final FileRecordMapper mapper;
    private final BaselineFileStore baselines;

    @Override
    public FileRecord put(@NonNull FileRecord record) {
        String executionId = String.valueOf(record.executionId());
        String id = record.id() == null ? String.valueOf(this.generateId()) : String.valueOf(record.id());
        String filePath = record.filePath();
        // 基线先落盘再登记：登记成功却引用不到基线，比重放失败更隐蔽。
        String baselinePath = record.baseline() == null ? null
                : this.baselines.write(executionId, id, record.baseline());

        FileRecordPO po = new FileRecordPO();
        po.setId(id);
        po.setExecutionId(executionId);
        po.setTurnId(record.turnId() == null ? null : String.valueOf(record.turnId()));
        po.setFilePath(filePath);
        po.setBaselinePath(baselinePath);
        po.setDiff(record.diff());
        po.setPlusLines(record.plusLines());
        po.setMinusLines(record.minusLines());
        po.setCreateAt(record.createAt() == null ? Instant.now() : record.createAt());
        this.insertWithAllocatedVersion(po);

        return FileRecord.builder()
                .id(id).executionId(record.executionId()).turnId(record.turnId())
                .version(po.getVersion()).filePath(filePath).baseline(record.baseline())
                .diff(record.diff()).plusLines(record.plusLines()).minusLines(record.minusLines())
                .createAt(po.getCreateAt())
                .build();
    }

    /**
     * 分配同文件的下一个版本号并插入。
     *
     * <p>「先查 MAX 再插入」有竞争窗口，但重复版本由 {@code (execution_id, file_path, version)}
     * 的唯一索引在库侧挡住 —— 不加约束时这里是同版本双写（静默错），加了就变成显式失败。
     * 不做重试：同一文件的两次编辑本来就是顺序发生的（真要并行，文件内容早就写坏了），
     * 为不存在的并发加补偿循环只会多一条永远进不去的分支。</p>
     */
    private void insertWithAllocatedVersion(FileRecordPO po) {
        po.setVersion(this.mapper.maxVersion(po.getExecutionId(), po.getFilePath()) + 1);
        this.mapper.insert(po);
    }

    @Override
    public Optional<FileRecord> get(@NonNull Serializable executionId, @NonNull Serializable recordId) {
        FileRecordPO po = this.mapper.selectByExecutionAndId(String.valueOf(executionId), String.valueOf(recordId));
        return po == null ? Optional.empty() : Optional.of(this.toRecord(po));
    }

    @Override
    public void clearByExecutionId(@NonNull Serializable executionId) {
        String key = String.valueOf(executionId);
        this.mapper.delete(new LambdaQueryWrapper<FileRecordPO>().eq(FileRecordPO::getExecutionId, key));
        // 基线只可能落在这个执行的目录下，整棵删掉即可；逐文件再删一遍是冗余步骤。
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

    /** 窄查询：只取一轮的行，不把其它轮次的基线读进内存。 */
    @Override
    public List<FileRecord> listByTurn(@NonNull Serializable executionId, Serializable turnId) {
        List<FileRecordPO> rows = this.mapper.listByTurn(String.valueOf(executionId),
                turnId == null ? null : String.valueOf(turnId));
        List<FileRecord> records = new ArrayList<>(rows.size());
        for (FileRecordPO row : rows) {
            records.add(this.toRecord(row));
        }
        return records;
    }

    /**
     * 本轮是否已为这个文件登记过记录。
     *
     * <p>{@code turnId} 为 {@code null} 也要当作「同一轮」去匹配：工具在正常链路之外被调用时
     * 拿不到轮次元数据，这些记录本身就归在 {@code null} 名下。这里若直接返回 {@code false}，
     * 同一文件的每次无轮次编辑都会重新保留一份全文基线 —— 正是 P2 消掉的那个放大。</p>
     */
    @Override
    public boolean existsForTurn(@NonNull Serializable executionId, Serializable turnId, @NonNull String filePath) {
        LambdaQueryWrapper<FileRecordPO> query = new LambdaQueryWrapper<FileRecordPO>()
                .eq(FileRecordPO::getExecutionId, String.valueOf(executionId))
                .eq(FileRecordPO::getFilePath, filePath);
        if (turnId == null) {
            query.isNull(FileRecordPO::getTurnId);
        } else {
            query.eq(FileRecordPO::getTurnId, String.valueOf(turnId));
        }
        return this.mapper.selectCount(query) > 0;
    }

    /** 过期记录条数：预览用，不读 diff 与基线。 */
    @Override
    public long countBefore(@NonNull Instant cutoff) {
        return this.mapper.countCreatedBefore(cutoff);
    }

    /**
     * 回收 {@code cutoff} 之前建立的记录（连同基线文件）。
     *
     * <p>条数以一次条件删的影响行为准，不再「先查出来自己数」。</p>
     *
     * @return 实际删除的记录条数
     */
    @Override
    public int purgeBefore(@NonNull Instant cutoff) {        // 先取基线路径再删行：行没了就再也找不到这些文件，会变成永久孤儿。
        List<FileRecordPO> expired = this.mapper.listCreatedBefore(cutoff);
        int deleted = this.mapper.delete(new LambdaQueryWrapper<FileRecordPO>()
                .lt(FileRecordPO::getCreateAt, cutoff));
        for (FileRecordPO po : expired) {
            this.baselines.delete(po.getBaselinePath());
        }
        return deleted;
    }

    /** 清空全部记录：仅测试与本地重置使用，生产不做全表删除。 */
    @Override
    public void clear() {
        List<String> executions = this.mapper.selectList(null).stream()
                .map(FileRecordPO::getExecutionId).distinct().toList();
        this.mapper.delete(new LambdaQueryWrapper<>());
        for (String executionId : executions) {
            this.baselines.deleteExecution(executionId);
        }
    }

    /** 库行 → 领域记录：基线按需从文件读回，读不到就当这条没有基线（不编造空文件）。 */
    private FileRecord toRecord(FileRecordPO po) {
        return FileRecord.builder()
                .id(po.getId()).executionId(po.getExecutionId()).turnId(po.getTurnId())
                .version(po.getVersion()).filePath(po.getFilePath())
                .baseline(this.baselines.read(po.getBaselinePath()).orElse(null))
                .diff(po.getDiff()).plusLines(po.getPlusLines()).minusLines(po.getMinusLines())
                .createAt(po.getCreateAt())
                .build();
    }
}
