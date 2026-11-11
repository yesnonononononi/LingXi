package com.summit.dp.workflow.infrastructure.tools.file.record;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.workflow.infrastructure.tools.file.record.persistence.FileRecordMapper;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 记录落 H2：真实文件库上验证「活过重启」这件事本身。
 *
 * <p>为什么必须是文件库：本类要证明的正是 {@code jdbc:h2:mem:} 会绕过去的部分 —— 记录文本、
 * CLOB 差异、自增顺序真的落盘了，换一个 store 实例（模拟进程重启）还能原样读回来。
 * 内存库在这里等于什么都没验。</p>
 *
 * <p>基线落文件系统，所以本类同时守三件事：</p>
 * <ol>
 *   <li>{@code put} 之后库里的 {@code baseline_path} 指向一个**真实存在**的文件，内容与原基线逐字相等；</li>
 *   <li>基线文件被人删掉时，读回来的记录是 {@code baseline = null}（当作没有基线），
 *       <b>不能</b>编成一个空文件 —— 空文件会让「整份文件都是新增」这种假差异一路骗到界面；</li>
 *   <li>过期回收把行与文件一起收掉，不会留下悬空引用。</li>
 * </ol>
 */
class H2FileRecordStoreTest {

    private static final String EXECUTION = "9001";
    private static final String TURN = "77";

    private H2TestDatabase database;
    private SqlSessionFactory sessionFactory;
    private Path baselineRoot;
    private H2FileRecordStore store;

    @BeforeEach
    void setUp() throws Exception {
        // 库落临时目录；基线库目录同样落临时目录，用例结束整目录删除，绝不留脏文件。
        database = H2TestDatabase.create("FileRecordStoreTest");
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(database.configuration(FileRecordMapper.class));
        factory.setPlugins(plugins);
        sessionFactory = factory.getObject();
        baselineRoot = Files.createTempDirectory("lingxi-baselines-");
        store = newStore();
    }

    @AfterEach
    void tearDown() throws Exception {
        database.close();
        try (var walk = Files.walk(baselineRoot)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (Exception ignored) {
                    // 临时目录清理失败不影响断言结论
                }
            });
        }
    }

    /** 每次新建实例都指向同一个库与同一个基线根：用来模拟「后端重启」。 */
    private H2FileRecordStore newStore() {
        FileRecordMapper mapper = H2TestDatabase.sqlSession(sessionFactory).getMapper(FileRecordMapper.class);
        return new H2FileRecordStore(mapper, new BaselineFileStore(baselineRoot.toString()));
    }

    @Test
    void baselineGoesToFileAndRecordSurvivesRestart() {
        FileRecord stored = store.put(draft("demo.txt", "v1\n", "+v2", null));

        assertNotNull(stored.id(), "缺失标识由存储补齐");
        assertEquals(1, stored.version(), "同文件首条版本从 1 起");

        List<FileRecord> beforeRestart = store.listByExecution(EXECUTION);
        assertEquals(1, beforeRestart.size());
        assertEquals("v1\n", beforeRestart.getFirst().baseline(), "基线须原样读回");

        // 重启 = 丢弃实例，用同一个库文件重新装配一个 store。
        H2FileRecordStore restarted = newStore();
        List<FileRecord> afterRestart = restarted.listByExecution(EXECUTION);

        assertEquals(1, afterRestart.size(), "记录必须活过重启（上一版是纯内存，重启即丢）");
        FileRecord reloaded = afterRestart.getFirst();
        assertEquals("v1\n", reloaded.baseline(), "基线从文件读回，不是从内存");
        assertEquals("+v2", reloaded.diff());
        assertEquals("demo.txt", reloaded.filePath());
        assertEquals(TURN, reloaded.turnId());
        assertEquals(1, reloaded.version());
    }

    @Test
    void baselineLivesOnDiskAsReferenceNotInTheRow() {
        FileRecord stored = store.put(draft("demo.txt", "v1\n", "+v2", null));

        String baselinePath = database.queryString(
                "SELECT baseline_path FROM file_record WHERE id = '" + stored.id() + "'");
        assertNotNull(baselinePath, "行里只能有路径");
        assertTrue(Path.of(baselinePath).isAbsolute(), "落库的是绝对路径");
        Path file = Path.of(baselinePath);
        assertTrue(file.startsWith(baselineRoot), "基线必须落在数据目录的 file-records 下");
        assertTrue(Files.isRegularFile(file));
    }

    @Test
    void newFileKeepsNullBaselineSoReaderKnowsItIsCreated() {
        store.put(draft("new.txt", null, "+one", null));

        String baselinePath = database.queryString("SELECT baseline_path FROM file_record LIMIT 1");

        assertNull(baselinePath, "新建文件没有基线，库里也不必留路径");
        assertNull(store.listByExecution(EXECUTION).getFirst().baseline());
    }

    @Test
    void recordsAreListedInInsertionOrderAndVersionsIncreasePerFile() {
        store.put(draft("a.txt", "a1\n", "+a2", null));
        store.put(draft("b.txt", "b1\n", "+b2", null));
        store.put(draft("a.txt", null, "+a3", null));

        List<FileRecord> listed = store.listByExecution(EXECUTION);

        assertEquals(List.of("a.txt", "b.txt", "a.txt"),
                listed.stream().map(FileRecord::filePath).toList(), "顺序是契约：差异重放依赖它");
        assertEquals(1, listed.get(0).version());
        assertEquals(1, listed.get(1).version(), "不同文件各自从 1 起");
        assertEquals(2, listed.get(2).version(), "同文件按写入顺序递增");
    }

    @Test
    void existsForTurnAnswersFromTheDatabaseNotFromHydratedBaselines() {
        store.put(draft("demo.txt", "v1\n", "+v2", null));

        assertTrue(store.existsForTurn(EXECUTION, TURN, "demo.txt"));
        assertFalse(store.existsForTurn(EXECUTION, "78", "demo.txt"), "别的轮次不算");
        assertFalse(store.existsForTurn(EXECUTION, TURN, "other.txt"), "别的文件不算");
        assertFalse(store.existsForTurn("9002", TURN, "demo.txt"), "别的执行不算");
        assertFalse(store.existsForTurn(EXECUTION, null, "demo.txt"), "没有轮次归属时不算改过");
    }

    @Test
    void getIsScopedByExecution() {
        FileRecord stored = store.put(draft("demo.txt", "v1\n", "+v2", null));

        assertTrue(store.get(EXECUTION, stored.id()).isPresent());
        assertEquals(Optional.empty(), store.get("9002", stored.id()), "执行隔离，不跨执行读");
    }

    @Test
    void missingBaselineFileReadsAsNoBaselineInsteadOfEmptyFile() throws Exception {
        FileRecord stored = store.put(draft("demo.txt", "v1\n", "+v2", null));
        Path baselineFile = Path.of(database.queryString(
                "SELECT baseline_path FROM file_record WHERE id = '" + stored.id() + "'"));
        Files.delete(baselineFile);

        FileRecord reloaded = store.get(EXECUTION, stored.id()).orElseThrow();

        assertNull(reloaded.baseline(), "读不到就当没有基线，不能编成空串（空串会被当成「整份新增」）");
        assertEquals("+v2", reloaded.diff(), "差异本身仍在");
    }

    @Test
    void purgeRemovesOldRecordsTogetherWithTheirBaselineFiles() throws Exception {
        Instant old = Instant.now().minus(20, ChronoUnit.DAYS);
        FileRecord stale = store.put(draft("old.txt", "old\n", "+old", old));
        store.put(draft("fresh.txt", "fresh\n", "+fresh", Instant.now()));
        Path staleBaseline = Path.of(database.queryString(
                "SELECT baseline_path FROM file_record WHERE id = '" + stale.id() + "'"));

        int purged = store.purgeBefore(Instant.now().minus(15, ChronoUnit.DAYS));

        assertEquals(1, purged);
        assertEquals(List.of("fresh.txt"), store.listByExecution(EXECUTION).stream()
                .map(FileRecord::filePath).toList(), "只删过期的那条");
        assertFalse(Files.exists(staleBaseline), "基线文件随记录一起删，不留孤儿");
        assertEquals("0", database.queryString("SELECT COUNT(1) FROM file_record WHERE id = '" + stale.id() + "'"));
        // 幂等：再跑一次没有可回收内容。
        assertEquals(0, store.purgeBefore(Instant.now().minus(15, ChronoUnit.DAYS)));
    }

    @Test
    void clearByExecutionRemovesRowsAndBaselineFiles() throws Exception {
        FileRecord stored = store.put(draft("demo.txt", "v1\n", "+v2", null));
        Path baseline = Path.of(database.queryString(
                "SELECT baseline_path FROM file_record WHERE id = '" + stored.id() + "'"));

        store.clearByExecutionId(EXECUTION);

        assertTrue(store.listByExecution(EXECUTION).isEmpty());
        assertFalse(Files.exists(baseline));
        assertFalse(Files.exists(baseline.getParent()), "执行目录也一并回收");
    }

    @Test
    void clearWipesEverythingForLocalReset() throws Exception {
        FileRecord stored = store.put(draft("demo.txt", "v1\n", "+v2", null));
        store.put(draft("b.txt", "b1\n", "+b2", null));
        Path baseline = Path.of(database.queryString(
                "SELECT baseline_path FROM file_record WHERE id = '" + stored.id() + "'"));

        store.clear();

        assertTrue(store.listByExecution(EXECUTION).isEmpty());
        assertFalse(Files.exists(baseline), "重置必须连基线文件一起清，否则磁盘上留一堆无主大文本");
    }

    /**
     * 行数必须原样读回：{@code plusLines/minusLines} 是汇总页唯一的数字来源，
     * 写成常量或漏写某个 setter 都不会报错，只会让「+N −M」永远显示 0。
     */
    @Test
    void lineCountsRoundTripThroughTheRow() {
        store.put(FileRecord.builder()
                .executionId((Serializable) EXECUTION).turnId((Serializable) TURN)
                .filePath("demo.txt").baseline("v1\n").diff("+v2")
                .plusLines(3).minusLines(2).createAt(Instant.now()).build());

        FileRecord reloaded = newStore().listByExecution(EXECUTION).getFirst();

        assertEquals(3, reloaded.plusLines());
        assertEquals(2, reloaded.minusLines());
    }

    private FileRecord draft(String path, String baseline, String diff, Instant createAt) {
        return FileRecord.builder()
                .executionId((Serializable) EXECUTION)
                .turnId((Serializable) TURN)
                .filePath(path)
                .baseline(baseline)
                .diff(diff)
                .plusLines(1)
                .minusLines(0)
                .createAt(createAt)
                .build();
    }
}
