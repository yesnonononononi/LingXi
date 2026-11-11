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
import java.util.Comparator;
import java.util.Optional;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
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
        try (Stream<Path> walk = Files.walk(baselineRoot)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> {
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

    /**
     * 链尾查询只取「标识 + 末态摘要」两列，并且按执行 / 轮次 / 文件三段定位。
     *
     * <p>登记器每次编辑都要问一次，所以它必须是一条窄查询：读成整行会把 diff 这个 CLOB
     * 也拖回来，退化成 P3 之前的写放大形态。</p>
     */
    @Test
    void findTurnFileTailReturnsTheLatestDigestOfThatTurnFile() {
        store.put(chainDraft("demo.txt", "v1\n", "+v2", TURN, "digest-1", true));
        store.put(chainDraft("other.txt", "o1\n", "+o2", TURN, "digest-other", true));
        FileRecord latest = store.put(chainDraft("demo.txt", null, "+v3", TURN, "digest-2", false));

        RecordTail tail = store.findTurnFileTail(EXECUTION, TURN, "demo.txt").orElseThrow();

        assertEquals(latest.id(), tail.id(), "取的是最后一条，不是第一条");
        assertEquals("digest-2", tail.contentDigest());
        assertEquals(Optional.empty(), store.findTurnFileTail(EXECUTION, "78", "demo.txt"), "别的轮次不算");
        assertEquals(Optional.empty(), store.findTurnFileTail(EXECUTION, TURN, "never.txt"), "别的文件不算");
        assertEquals(Optional.empty(), store.findTurnFileTail("9002", TURN, "demo.txt"), "别的执行不算");
    }

    /**
     * 没有轮次归属的编辑也算「同一轮」。
     *
     * <p>工具在正常链路之外被调用时拿不到轮次元数据，这类记录本身就归在 {@code null} 名下。
     * 若这里判成「查不到」，同一文件的每次无轮次编辑都会重新保留一份全文基线 ——
     * 正是 P2 消掉的那个内存放大。</p>
     */
    @Test
    void recordsWithoutTurnBelongToTheSameBucket() {
        store.put(chainDraft("demo.txt", "v1\n", "+v2", null, "digest-null-turn", true));

        assertTrue(store.findTurnFileTail(EXECUTION, null, "demo.txt").isPresent(), "无轮次记录也必须被算作已改过");
        assertEquals(Optional.empty(), store.findTurnFileTail(EXECUTION, null, "other.txt"));
    }

    /**
     * 摘要与分段标记必须原样读回。
     *
     * <p>漏写 setter 是静默型缺陷：链尾摘要丢了，下一次编辑就会被当成「链断了」重新留一份基线，
     * 或者更糟 —— 被当成还连着而把一个断掉的链重放一遍。两条断言分别守这两种结局。</p>
     */
    @Test
    void digestAndSegmentFlagRoundTripThroughTheRow() {
        store.put(chainDraft("demo.txt", "v1\n", "+v2", TURN, "digest-1", true));

        FileRecord reloaded = newStore().listByExecution(EXECUTION).getFirst();

        assertEquals("digest-1", reloaded.contentDigest());
        assertTrue(reloaded.segmentStart());
    }

    /**
     * 分段起点带着自己的基线：链断过一次之后，断点那段仍能重放出来。
     *
     * <p>这是本次修复的核心可观测性保证 —— 断链只丢一段历史，不丢整份差异。</p>
     */
    @Test
    void everySegmentStartKeepsItsOwnBaselineFile() {
        store.put(chainDraft("demo.txt", "v1\n", "+v2", TURN, "digest-1", true));
        store.put(chainDraft("demo.txt", "手改\n", "+v3", TURN, "digest-2", true));

        List<FileRecord> listed = store.listByExecution(EXECUTION);

        assertEquals("v1\n", listed.get(0).baseline());
        assertEquals("手改\n", listed.get(1).baseline(), "第二段必须自带基线");
        assertTrue(listed.get(1).segmentStart());
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
        assertTrue(reloaded.baselineMissing(), "有基线引用却没内容 = 基线丢了，必须和「本轮新建」区分开");
        assertEquals("+v2", reloaded.diff(), "差异本身仍在");
    }

    /**
     * 按文件名取最新：作用域由调用方给的轮次集合界定，顺序由 {@code seq} 承担。
     *
     * <p>「最新」不能靠 {@code create_at} 猜：同一毫秒插入的两条记录时间可能相同，
     * 而 {@code seq} 是库发放的严格顺序。</p>
     */
    @Test
    void findLatestRecordPicksTheNewestRowWithinTheGivenTurns() {
        store.put(draft("demo.txt", "v1\n", "+v2", null, TURN));
        store.put(draft("other.txt", "o1\n", "+o2", null, "78"));
        store.put(draft("demo.txt", null, "+v3", null, "78"));

        FileRecord latest = store.findLatestRecord("demo.txt", List.of(TURN, "78")).orElseThrow();

        assertEquals("78", latest.turnId(), "取的是更晚那一轮的行");
        assertEquals(2, latest.version(), "同执行同文件的第二版");
        assertEquals("+v3", latest.diff());
        assertTrue(store.findLatestRecord("demo.txt", List.of("999")).isEmpty(), "作用域外的轮次不参与");
        assertTrue(store.findLatestRecord("demo.txt", List.of()).isEmpty(), "空作用域直接返回空，不拼 IN ()");
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

    /**
     * 「同执行 + 同文件 + 同版本」在库侧唯一。
     *
     * <p>版本号是 {@code MAX(version)+1} 现场分配的，没有这条约束时并发撞车的后果是两条同版本
     * 记录并存 —— 不报错、不显眼，只是重放链上多出一段没人认识的顺序。这里直接绕过 store 写两次
     * 同版本，证明拦得住的是库而不是应用。</p>
     */
    @Test
    void sameFileVersionCannotBeWrittenTwice() {
        store.put(draft("demo.txt", "v1\n", "+v2", null));

        RuntimeException conflict = assertThrows(RuntimeException.class, () -> database.execute(
                "INSERT INTO file_record (id, execution_id, turn_id, version, file_path,"
                        + " plus_lines, minus_lines, create_at)"
                        + " VALUES ('dup', '" + EXECUTION + "', '" + TURN + "', 1, 'demo.txt', 0, 0, CURRENT_TIMESTAMP)"));

        assertFalse(conflict.getMessage().isBlank(), "撞版本必须报错，不能静默写进去");
        assertEquals("1", database.queryString("SELECT COUNT(1) FROM file_record WHERE file_path = 'demo.txt'"));
    }

    /** 列表窄查询只取本轮：其它轮次的行根本不该出现在结果里。 */
    @Test
    void listByTurnNarrowsToTheRequestedTurn() {
        store.put(draft("mine.txt", "m1\n", "+m2", null));
        store.put(draft("other.txt", "o1\n", "+o2", null, "78"));

        List<FileRecord> mine = store.listByTurn(EXECUTION, TURN);

        assertEquals(List.of("mine.txt"), mine.stream().map(FileRecord::filePath).toList());
        assertEquals("m1\n", mine.getFirst().baseline(), "基线仍按需读回");
    }

    /** 无轮次记录自成一桶：{@code turnId = null} 要按 IS NULL 取，不能退化成「查不到」。 */
    @Test
    void listByTurnKeepsTheTurnlessBucket() {
        store.put(draft("no-turn.txt", "n1\n", "+n2", null, null));
        store.put(draft("mine.txt", "m1\n", "+m2", null));

        List<FileRecord> turnless = store.listByTurn(EXECUTION, null);

        assertEquals(List.of("no-turn.txt"), turnless.stream().map(FileRecord::filePath).toList());
    }

    /** 预览用的过期条数：只数 create_at 水位之前的行，且不读 diff 与基线。 */
    @Test
    void countBeforeCountsOnlyExpiredRows() {
        store.put(draft("old.txt", "old\n", "+old", Instant.now().minus(20, ChronoUnit.DAYS)));
        store.put(draft("fresh.txt", "fresh\n", "+fresh", Instant.now()));

        assertEquals(1, store.countBefore(Instant.now().minus(15, ChronoUnit.DAYS)));
        assertEquals(0, store.countBefore(Instant.now().minus(30, ChronoUnit.DAYS)));
    }

    private FileRecord draft(String path, String baseline, String diff, Instant createAt) {
        return draft(path, baseline, diff, createAt, TURN);
    }

    private FileRecord draft(String path, String baseline, String diff, Instant createAt, String turnId) {
        return FileRecord.builder()
                .executionId((Serializable) EXECUTION)
                .turnId(turnId)
                .filePath(path)
                .baseline(baseline)
                .diff(diff)
                .plusLines(1)
                .minusLines(0)
                .createAt(createAt)
                .build();
    }

    /** 带链信息的记录：摘要与分段标记是链能否重放的关键，单独一个入口免得把参数串错位。 */
    private FileRecord chainDraft(String path, String baseline, String diff, String turnId,
                                  String contentDigest, boolean segmentStart) {
        return FileRecord.builder()
                .executionId((Serializable) EXECUTION)
                .turnId(turnId)
                .filePath(path)
                .baseline(baseline)
                .diff(diff)
                .plusLines(1)
                .minusLines(0)
                .contentDigest(contentDigest)
                .segmentStart(segmentStart)
                .createAt(Instant.now())
                .build();
    }
}
