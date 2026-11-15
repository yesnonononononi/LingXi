package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.tools.file.record.BaselineFileStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.ContentDigest;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.InMemoryFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.LocalRollbackFileAccess;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.io.Serializable;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 真文件上的回填：基线原文是否逐字节写回、备份是否留下、失败是否被隔离。
 *
 * <p>断言内容用逐字相等，不用行数或摘要 —— 回填要的是字节级还原，而重放产物被 {@code \n} 归一过，
 * 拿它当标准会把「换行被悄悄改掉」这种缺陷判成通过。</p>
 */
class FileRollbackServiceTest {

    private static final String EXECUTION = "8101";
    private static final String TURN = "21";

    @TempDir
    Path tempDir;

    private InMemoryFileRecordStore store;
    private FileRecordManager records;
    private BaselineFileStore backups;

    @BeforeEach
    void setUp() {
        this.store = new InMemoryFileRecordStore();
        this.records = new DefaultFileRecordManager(this.store);
        this.backups = new BaselineFileStore(this.tempDir.resolve("data").toString());
    }

    @Test
    void restoresBaselineBytesAndKeepsAPreRollbackBackup() throws IOException {
        Path target = this.tempDir.resolve("demo.ts");
        Files.writeString(target, "执行末态\r\n第二行\r\n", StandardCharsets.UTF_8);
        this.record(target, "执行前\r\n第二行\r\n", StandardCharsets.UTF_8, "执行末态\r\n第二行\r\n");

        FileRollbackResult result = this.service(new LocalRollbackFileAccess())
                .rollback(8101L, List.of(target.normalize().toString()));

        assertEquals(1, result.successCount());
        assertEquals("执行前\r\n第二行\r\n", Files.readString(target, StandardCharsets.UTF_8),
                "CRLF 必须原样回来，不能顺手归一成 \\n");
        String backupPath = result.outcomes().getFirst().backupPath();
        assertNotNull(backupPath, "回滚前必须留一份备份");
        assertEquals("执行末态\r\n第二行\r\n", Files.readString(Path.of(backupPath), StandardCharsets.UTF_8),
                "备份是覆盖前的原内容，用户靠它反悔");
        assertTrue(Path.of(backupPath).startsWith(this.tempDir.resolve("data").resolve("file-records")),
                "备份落在数据目录下，回收执行时随目录一并删除");
    }

    @Test
    void deletesFileThatWasCreatedDuringTheExecution() throws IOException {
        Path target = this.tempDir.resolve("created.ts");
        Files.writeString(target, "新建内容\n", StandardCharsets.UTF_8);
        this.store.put(FileRecord.builder()
                .executionId((Serializable) EXECUTION).turnId((Serializable) TURN)
                .filePath(target.normalize().toString()).baseline(null).diff("+新建内容")
                .plusLines(1).minusLines(0).contentDigest(ContentDigest.compute("新建内容\n"))
                .segmentStart(true).createAt(Instant.now()).build());

        FileRollbackResult result = this.service(new LocalRollbackFileAccess())
                .rollback(8101L, List.of(target.normalize().toString()));

        assertEquals(FileRollbackAction.DELETE, result.outcomes().getFirst().action());
        assertFalse(Files.exists(target), "执行期间新建的文件，回滚就是删掉");
        assertTrue(Files.isRegularFile(Path.of(result.outcomes().getFirst().backupPath())), "删之前同样留备份");
    }

    /** 确认清单只能从计划里挑：自带路径不能变成「按任意绝对路径写盘」。 */
    @Test
    void ignoresPathsThatAreNotInThePlan() throws IOException {
        Path target = this.tempDir.resolve("demo.ts");
        Path stranger = this.tempDir.resolve("stranger.ts");
        Files.writeString(target, "末态\n", StandardCharsets.UTF_8);
        Files.writeString(stranger, "路人文件\n", StandardCharsets.UTF_8);
        this.record(target, "执行前\n", StandardCharsets.UTF_8, "末态\n");

        FileRollbackService service = this.service(new LocalRollbackFileAccess());
        ClientException ignored = assertThrows(ClientException.class,
                () -> service.rollback(8101L, List.of(stranger.normalize().toString())));

        assertEquals("确认的文件都不在可回滚范围内，请重新预览", ignored.getMessage(), "计划外的路径一条也不执行");
        assertEquals("路人文件\n", Files.readString(stranger, StandardCharsets.UTF_8));
        ClientException empty = assertThrows(ClientException.class, () -> service.rollback(8101L, List.of()));
        assertEquals("请先确认要回滚的文件", empty.getMessage());
    }

    /** 单个文件写失败不影响其它文件，且失败事实必须逐条交回。 */
    @Test
    void oneFailingFileDoesNotBlockTheOthers() throws IOException {
        Path ok = this.tempDir.resolve("ok.ts");
        Path broken = this.tempDir.resolve("broken.ts");
        Files.writeString(ok, "ok末态\n", StandardCharsets.UTF_8);
        Files.writeString(broken, "broken末态\n", StandardCharsets.UTF_8);
        this.record(ok, "ok执行前\n", StandardCharsets.UTF_8, "ok末态\n");
        this.record(broken, "broken执行前\n", StandardCharsets.UTF_8, "broken末态\n");

        FileRollbackResult result = this.service(new FailingWriteAccess(broken))
                .rollback(8101L, List.of(ok.normalize().toString(), broken.normalize().toString()));

        assertEquals(2, result.outcomes().size());
        assertEquals(1, result.successCount(), "一个成功");
        assertEquals(1, result.failureCount(), "一个失败，不能整批报错");
        assertEquals("ok执行前\n", Files.readString(ok, StandardCharsets.UTF_8));
        assertEquals("broken末态\n", Files.readString(broken, StandardCharsets.UTF_8), "失败的那个文件不动");
    }

    /** 写成功的文件才打回滚标记，第二次预览必须说出「已回滚过」。 */
    @Test
    void marksRolledBackOnlyAfterTheBytesAreWritten() throws IOException {
        Path target = this.tempDir.resolve("demo.ts");
        Files.writeString(target, "执行末态\n", StandardCharsets.UTF_8);
        this.record(target, "执行前\n", StandardCharsets.UTF_8, "执行末态\n");
        FileRollbackService service = this.service(new LocalRollbackFileAccess());
        String path = target.normalize().toString();

        assertEquals(null, this.records.findFileTail(EXECUTION, path).orElseThrow().rolledBackAt(),
                "写盘之前不能有标记，否则回滚失手就永久不可回滚");
        service.rollback(8101L, List.of(path));

        assertNotNull(this.records.findFileTail(EXECUTION, path).orElseThrow().rolledBackAt(), "写成功后打标记");
        assertEquals("该文件已回滚过", service.preview(8101L).items().getFirst().reason());
    }

    /** 写失败的文件不打标记：它还有机会重试，标上就等于把门关死了。 */
    @Test
    void keepsFailedFileRetryable() throws IOException {
        Path broken = this.tempDir.resolve("broken.ts");
        Files.writeString(broken, "broken末态\n", StandardCharsets.UTF_8);
        this.record(broken, "broken执行前\n", StandardCharsets.UTF_8, "broken末态\n");
        String path = broken.normalize().toString();

        FileRollbackResult result = this.service(new FailingWriteAccess(broken)).rollback(8101L, List.of(path));

        assertEquals(1, result.failureCount());
        assertNull(this.records.findFileTail(EXECUTION, path).orElseThrow().rolledBackAt(), "失败不打标记");
    }

    /** 全都不可回滚时，错误文案要摊开跳过数量，不能只说一句「没有可回滚的」。 */
    @Test
    void explainsWhyNothingCanBeRolledBack() throws IOException {
        Path target = this.tempDir.resolve("demo.ts");
        Files.writeString(target, "用户后来改的\n", StandardCharsets.UTF_8);
        this.record(target, "执行前\n", StandardCharsets.UTF_8, "执行末态\n");

        ClientException failure = assertThrows(ClientException.class,
                () -> this.service(new LocalRollbackFileAccess()).rollback(8101L,
                        List.of(target.normalize().toString())));

        assertTrue(failure.getMessage().contains("没有可回滚的文件"), failure.getMessage());
        assertTrue(failure.getMessage().contains("跳过 1 个"), "要说明有几个文件被跳过");
    }

    private FileRollbackService service(RollbackFileAccess access) {
        FileRollbackPlanner planner = new FileRollbackPlanner(this.records, access,
                this.tempDir.resolve("data").toString());
        return new FileRollbackService(planner, access, this.backups, this.records);
    }

    private void record(Path target, String before, java.nio.charset.Charset charset, String after) {
        this.store.put(FileRecord.builder()
                .executionId((Serializable) EXECUTION).turnId((Serializable) TURN)
                .filePath(target.normalize().toString()).baseline(before).diff("+" + after)
                .plusLines(1).minusLines(0).contentDigest(ContentDigest.compute(after))
                .segmentStart(true).createAt(Instant.now()).build());
    }

    /** 写指定路径时抛异常，其它路径照常：用来验证失败隔离。 */
    private static final class FailingWriteAccess implements RollbackFileAccess {

        private final LocalRollbackFileAccess delegate = new LocalRollbackFileAccess();
        private final String brokenPath;

        private FailingWriteAccess(Path brokenPath) {
            this.brokenPath = brokenPath.normalize().toString();
        }

        @Override
        public boolean exists(String absolutePath) {
            return this.delegate.exists(absolutePath);
        }

        @Override
        public Optional<String> read(String absolutePath) {
            return this.delegate.read(absolutePath);
        }

        @Override
        public void write(String absolutePath, String content) {
            if (this.brokenPath.equals(Path.of(absolutePath).normalize().toString())) {
                throw new IllegalStateException("磁盘写不进去");
            }
            this.delegate.write(absolutePath, content);
        }

        @Override
        public void delete(String absolutePath) {
            this.delegate.delete(absolutePath);
        }
    }
}
