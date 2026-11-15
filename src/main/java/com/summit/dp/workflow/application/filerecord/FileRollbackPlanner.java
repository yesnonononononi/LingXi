package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.workflow.infrastructure.tools.file.record.ContentDigest;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.RecordTail;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 把一次执行的文件改动算成「能回滚 / 不能回滚」的清单，全程只读。
 *
 * <p><b>回滚上界</b>：只能回到「该文件在本执行中首次被工具修改之前」的形态。分段会因跨轮次与断链
 * 反复重开，所以基线只认最早那条 —— 取最新那段回填的是执行中途的状态，界面还会说「已回到改动前」。</p>
 *
 * <p>门禁顺序按「便宜的先判」排：路径形态 → 基线可读 → 末态校验。末态那步要读盘算摘要，最贵。</p>
 */
@Slf4j
@Component
public class FileRollbackPlanner {

    private final FileRecordManager records;
    private final RollbackFileAccess files;
    /** 数据目录本身绝不允许被回滚写入：那里是我们的库、基线与检查点。 */
    private final Path dataRoot;

    public FileRollbackPlanner(FileRecordManager records, RollbackFileAccess files,
                               @Value("${lingxi.data.dir}") String dataDir) {
        this.records = records;
        this.files = files;
        this.dataRoot = Path.of(dataDir).toAbsolutePath().normalize();
    }

    /**
     * 算出这次执行的回滚计划。
     *
     * @param executionId 执行标识
     * @return 每个被记录的文件一行；该执行没有记录时为空计划
     */
    public FileRollbackPlan plan(long executionId) {
        String key = String.valueOf(executionId);
        List<FileRollbackItem> items = new ArrayList<>();
        for (FileRecord earliest : this.records.earliestPerFile(key)) {
            items.add(this.judge(key, earliest));
        }
        return new FileRollbackPlan(key, items);
    }

    /** 单文件的全部判定：先排除不该动的，再排除不能安全动的。 */
    private FileRollbackItem judge(String executionKey, FileRecord earliest) {
        String recordId = String.valueOf(earliest.id());
        String rawPath = earliest.filePath();
        if (rawPath == null || rawPath.isBlank()) {
            return FileRollbackItem.skip(rawPath, "记录缺少文件路径", recordId);
        }
        Path target = this.normalize(rawPath);
        if (target == null) {
            return FileRollbackItem.skip(rawPath, "记录里的路径不是绝对路径，不敢写回", recordId);
        }
        if (target.startsWith(this.dataRoot)) {
            return FileRollbackItem.skip(target.toString(), "拒绝写入数据目录", recordId);
        }
        // 有基线引用却读不回内容 = 基线已被回收，此时任何「回填」都是编造。
        if (earliest.baselineMissing()) {
            return FileRollbackItem.skip(target.toString(), "基线已过期，无法回滚", recordId);
        }
        return this.judgeCurrentState(executionKey, earliest, target);
    }

    /**
     * 末态门禁：执行结束后有人动过这个文件，就不许覆盖。
     *
     * <p>这是当年 {@code requireUnchanged} 的等价物，不能省：没有它，回滚就是拿旧内容覆盖用户
     * 今天的劳动。顺手把「已经是回滚后的内容」也在这里认出来 —— 否则重复执行会被报成
     * 「被外部修改过」，把一次无害的重复操作说成事故。</p>
     */
    private FileRollbackItem judgeCurrentState(String executionKey, FileRecord earliest, Path target) {
        String filePath = target.toString();
        String recordId = String.valueOf(earliest.id());
        Optional<RecordTail> tail = this.records.findFileTail(executionKey, filePath);
        if (tail.isEmpty()) {
            return FileRollbackItem.skip(filePath, "找不到末态记录，无法校验当前内容", recordId);
        }
        // 回滚是持久事实，不看内容碰巧长什么样：用户回滚后又手改回原样，也不能再回填一次。
        if (tail.get().rolledBackAt() != null) {
            return FileRollbackItem.skip(filePath, "该文件已回滚过", recordId);
        }
        if (!this.files.exists(filePath)) {
            return FileRollbackItem.skip(filePath, "文件已不存在，无需回滚", recordId);
        }
        Optional<String> read = this.files.read(filePath);
        if (read.isEmpty()) {
            return FileRollbackItem.skip(filePath, "文件读不出来，无法校验当前内容", recordId);
        }
        String current = read.get();
        // 首次记录没有基线 = 该文件在执行期间才出现，回滚动作是删除它。
        boolean created = earliest.baseline() == null;
        if (!created && earliest.baseline().equals(current)) {
            return FileRollbackItem.skip(filePath, "文件已是回滚后的内容，无需回滚", recordId);
        }
        if (tail.get().contentDigest() == null) {
            return FileRollbackItem.skip(filePath, "记录过旧，无法校验当前内容", recordId);
        }
        if (!tail.get().contentDigest().equals(ContentDigest.compute(current))) {
            return FileRollbackItem.skip(filePath, "执行结束后文件被改动过", recordId);
        }
        return created ? FileRollbackItem.delete(filePath, recordId)
                : FileRollbackItem.restore(filePath, earliest.baseline(), recordId);
    }

    /** 只接受绝对路径；能 normalize 的一律保留规范化结果，写盘与判定必须用同一个值。 */
    private Path normalize(String filePath) {
        try {
            Path path = Path.of(filePath);
            return path.isAbsolute() ? path.normalize() : null;
        } catch (RuntimeException invalid) {
            return null;
        }
    }
}
