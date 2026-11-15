package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.workflow.infrastructure.tools.file.record.ContentDigest;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.InMemoryFileRecordStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.Serializable;
import java.nio.file.Path;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 回滚计划的门禁逐条验证：每一条都能独立挡住一次会弄坏用户文件的操作。
 *
 * <p>这里用内存记录 + 内存文件，判定的正确性与磁盘无关；真文件那条路径由
 * {@code FileRollbackServiceTest} 负责。</p>
 */
class FileRollbackPlannerTest {

    private static final String EXECUTION = "7001";
    private static final String TURN = "11";

    @TempDir
    Path tempDir;

    private InMemoryFileRecordStore store;
    private FileRecordManager records;
    private FakeFileAccess files;
    private FileRollbackPlanner planner;
    private Path dataRoot;

    @BeforeEach
    void setUp() {
        this.store = new InMemoryFileRecordStore();
        this.records = new DefaultFileRecordManager(this.store);
        this.files = new FakeFileAccess();
        this.dataRoot = this.tempDir.resolve("data");
        this.planner = new FileRollbackPlanner(this.records, this.files, this.dataRoot.toString());
    }

    @Test
    void restoresTheFileToItsEarliestBaseline() {
        Path target = this.tempDir.resolve("demo.ts");
        this.files.put(target.toString(), "改完之后\n");
        this.record(target, "改之前\n", "改完之后\n", ContentDigest.compute("改完之后\n"), true);

        FileRollbackPlan plan = this.planner.plan(7001L);

        FileRollbackItem item = plan.items().getFirst();
        assertEquals(FileRollbackAction.RESTORE, item.action());
        assertEquals("改之前\n", item.baseline(), "回填的是基线原文");
        assertEquals(target.normalize().toString(), item.filePath());
        assertTrue(plan.hasAction());
    }

    /** 分段重开后有两份基线：回滚只认最早那份，否则回填出来的是执行中途的状态。 */
    @Test
    void earliestSegmentWinsOverLaterSegment() {
        Path target = this.tempDir.resolve("demo.ts");
        this.files.put(target.toString(), "末态\n");
        this.record(target, "执行前\n", "第一次改完\n", ContentDigest.compute("第一次改完\n"), true);
        this.record(target, "被工具外改过\n", "末态\n", ContentDigest.compute("末态\n"), true);

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.RESTORE, item.action());
        assertEquals("执行前\n", item.baseline(), "取第一段的基线，不是断链重开后那份");
    }

    /** 基线被回收：不许猜、不许写空，直接跳过。 */
    @Test
    void skipsWhenBaselineWasCollected() {
        Path target = this.tempDir.resolve("demo.ts");
        this.files.put(target.toString(), "改完之后\n");
        this.store.put(FileRecord.builder()
                .executionId((Serializable) EXECUTION).turnId((Serializable) TURN)
                .filePath(target.toString()).baseline(null).diff("+x")
                .plusLines(1).minusLines(0).contentDigest("digest-after")
                .segmentStart(true).baselineMissing(true).createAt(Instant.now()).build());

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.SKIP, item.action());
        assertEquals("基线已过期，无法回滚", item.reason());
    }

    /** 执行结束后用户又改过：回填就是覆盖他的劳动。 */
    @Test
    void skipsWhenFileChangedAfterTheExecution() {
        Path target = this.tempDir.resolve("demo.ts");
        this.files.put(target.toString(), "用户后来改的\n");
        this.record(target, "执行前\n", "执行末态\n", "digest-of-execution-end", true);

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.SKIP, item.action());
        assertEquals("执行结束后文件被改动过", item.reason());
    }

    /** 重复回滚是幂等的：内容已经等于基线时，说「无需回滚」而不是「被外部修改」。 */
    @Test
    void skipsWhenFileIsAlreadyTheRolledBackContent() {
        Path target = this.tempDir.resolve("demo.ts");
        this.files.put(target.toString(), "执行前\n");
        this.record(target, "执行前\n", "执行末态\n", "digest-of-execution-end", true);

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.SKIP, item.action());
        assertEquals("文件已是回滚后的内容，无需回滚", item.reason());
    }

    /**
     * 回滚过的文件靠 {rolled_back_at} 认出来，不靠「内容碰巧等于基线」。
     *
     * <p>用户回滚后又手改回执行末态，内容校验会重新放行 —— 只有持久标记能挡住第二次回填。</p>
     */
    @Test
    void skipsFilesAlreadyRolledBack() {
        Path target = this.tempDir.resolve("demo.ts");
        this.files.put(target.toString(), "改完之后\n");
        this.record(target, "改之前\n", "改完之后\n", ContentDigest.compute("改完之后\n"), true);
        this.records.markRolledBack(EXECUTION, List.of(target.toString()), Instant.now());

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.SKIP, item.action());
        assertEquals("该文件已回滚过", item.reason(), "持久标记优先于内容比对");
    }

    /** 执行期间新建的文件：首条没有基线，回滚动作是删除，不是写成空文件。 */
    @Test
    void deletesFileCreatedDuringExecution() {
        Path target = this.tempDir.resolve("created.ts");
        this.files.put(target.toString(), "新建内容\n");
        this.record(target, null, "新建内容\n", ContentDigest.compute("新建内容\n"), true);

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.DELETE, item.action());
        assertNull(item.baseline());
    }

    /** 新建后又被人改过：同样不许删，那已经不算「执行留下的东西」。 */
    @Test
    void skipsDeletingCreatedFileThatWasChangedLater() {
        Path target = this.tempDir.resolve("created.ts");
        this.files.put(target.toString(), "用户补充过\n");
        this.record(target, null, "新建内容\n", ContentDigest.compute("新建内容\n"), true);

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.SKIP, item.action());
        assertEquals("执行结束后文件被改动过", item.reason());
    }

    @Test
    void skipsRelativePathBecauseItWouldWriteIntoTheProcessDirectory() {
        this.files.put("relative.ts", "内容\n");
        this.record(Path.of("relative.ts"), "旧\n", "内容\n", ContentDigest.compute("内容\n"), true);

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.SKIP, item.action());
        assertEquals("记录里的路径不是绝对路径，不敢写回", item.reason());
    }

    @Test
    void rejectsPathsInsideTheDataDirectory() {
        Path target = this.dataRoot.resolve("lingxi-h2.mv.db");
        this.files.put(target.toString(), "内容\n");
        this.record(target, "旧\n", "内容\n", ContentDigest.compute("内容\n"), true);

        FileRollbackItem item = this.planner.plan(7001L).items().getFirst();

        assertEquals(FileRollbackAction.SKIP, item.action());
        assertEquals("拒绝写入数据目录", item.reason());
    }

    @Test
    void skipsWhenFileIsGoneAndSkipsWhenRecordHasNoDigest() {
        Path gone = this.tempDir.resolve("gone.ts");
        this.record(gone, "旧\n", "新\n", ContentDigest.compute("新\n"), true);
        assertEquals("文件已不存在，无需回滚", this.planner.plan(7001L).items().getFirst().reason());

        Path legacy = this.tempDir.resolve("legacy.ts");
        this.files.put(legacy.toString(), "新\n");
        this.record(legacy, "旧\n", "新\n", null, true);

        FileRollbackItem legacyItem = this.planner.plan(7001L).items().get(1);
        assertEquals(FileRollbackAction.SKIP, legacyItem.action());
        assertEquals("记录过旧，无法校验当前内容", legacyItem.reason());
    }

    @Test
    void emptyPlanWhenExecutionHasNoRecords() {
        FileRollbackPlan plan = this.planner.plan(7001L);

        assertTrue(plan.items().isEmpty());
        assertFalse(plan.hasAction(), "没有记录就没有可回滚的东西，不能凭空造一行");
    }

    /** 造一条记录：首条即分段起点，{@code after} 是这一段的末态。 */
    private void record(Path target, String before, String after, String digest, boolean segmentStart) {
        this.store.put(FileRecord.builder()
                .executionId((Serializable) EXECUTION).turnId((Serializable) TURN)
                .filePath(target.toString()).baseline(before).diff("+" + after)
                .plusLines(1).minusLines(0).contentDigest(digest)
                .segmentStart(segmentStart).createAt(Instant.now()).build());
    }

    /** 内存文件：只实现回滚用到的四个动作，读写口径与生产实现一致（不做换行归一）。 */
    private static final class FakeFileAccess implements RollbackFileAccess {

        private final Map<String, String> content = new HashMap<>();

        void put(String path, String text) {
            this.content.put(Path.of(path).normalize().toString(), text);
        }

        @Override
        public boolean exists(String absolutePath) {
            return absolutePath != null && this.content.containsKey(Path.of(absolutePath).normalize().toString());
        }

        @Override
        public Optional<String> read(String absolutePath) {
            return Optional.ofNullable(this.content.get(Path.of(absolutePath).normalize().toString()));
        }

        @Override
        public void write(String absolutePath, String text) {
            this.put(absolutePath, text);
        }

        @Override
        public void delete(String absolutePath) {
            this.content.remove(Path.of(absolutePath).normalize().toString());
        }
    }
}
