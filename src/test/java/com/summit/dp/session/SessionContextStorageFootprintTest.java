package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.infrastructure.context.LocalSessionContextFileStore;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import com.summit.dp.shared.utils.TestTimeouts;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 库体积守卫：上下文正文必须落在文件里，反复替换**不许**把库撑大。
 *
 * <p><b>为什么要有这条用例</b>：正文写回 CLOB 不会让任何功能报错，只会让 {@code .mv.db} 按轮次膨胀
 * （H2 的 LOB 页释放后不归还文件），表现出来是「用了两个月，库好几个 G」。
 * 唯一能提前发现的办法就是在真库上量文件大小。</p>
 *
 * <p>判据刻意留了余量：MVStore 有自身的分块与预分配，静止库也会小幅波动；但「每轮一段大正文」
 * 的量级（{@link #ROUNDS} × {@link #PAYLOAD_CHARS}）远大于这个余量，回归时一定越线。</p>
 */
@SpringJUnitConfig(SessionContextStorageFootprintTest.Config.class)
class SessionContextStorageFootprintTest {

    /** 反复替换的轮数：够多才能把「每轮一段 CLOB」的线性增长量出来。 */
    private static final int ROUNDS = 40;
    /** 每轮正文规模（字符）：单轮就超过允许的总增量，正文一旦入库必然越线。 */
    private static final int PAYLOAD_CHARS = 20_000;
    /** 允许的库文件增长上限（字节）：只容得下元数据与 MVStore 的正常波动。 */
    private static final long GROWTH_BUDGET_BYTES = 2L * 1024 * 1024;

    private static final long SESSION_ID = 812L;

    @Autowired
    private ModelContextService service;
    @Autowired
    private SessionContextMapper contexts;
    @Autowired
    private H2TestDatabase database;
    /** 正文目录与 {@link Config#store} 用的是同一个：用例自己建、自己收。 */
    private final Path dataDir = Path.of(FOOTPRINT_DIR);

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void repeatedReplacementKeepsTheDatabaseFlat() throws IOException {
        long before = sizeOfDatabase();
        for (int round = 0; round < ROUNDS; round++) {
            service.replace(SESSION_ID, messages(round));
        }
        long after = sizeOfDatabase();

        SessionContextPO row = contexts.selectById(SESSION_ID);
        assertNotNull(row, "替换必须落一行引用");
        assertNull(row.getContent(), "正文不得回写 CLOB：库里只留正文标识");
        assertNotNull(row.getSnapshotFile(), "库内必须留正文标识");

        long growth = after - before;
        assertTrue(growth <= GROWTH_BUDGET_BYTES,
                () -> "反复替换把库撑大了 " + growth + " 字节（预算 " + GROWTH_BUDGET_BYTES
                        + "）：正文很可能又被写回了 CLOB");
    }

    /** 磁盘上也只该剩最后一份正文：整笔替换不是追加。 */
    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    void onlyTheLatestBodyStaysOnDisk() throws IOException {
        for (int round = 0; round < 5; round++) {
            service.replace(SESSION_ID, messages(round));
        }
        SessionContextPO row = contexts.selectById(SESSION_ID);
        Path directory = dataDir.resolve("session-context").resolve(Long.toString(SESSION_ID));
        List<String> files;
        try (Stream<Path> entries = Files.list(directory)) {
            files = entries.map(path -> path.getFileName().toString()).toList();
        }
        assertEquals(List.of(row.getSnapshotFile() + ".jsonl"), files,
                "会话上下文目录里只能留下库内引用的那一份正文");
    }

    private long sizeOfDatabase() throws IOException {
        return Files.size(database.databaseFile());
    }

    private static List<Message> messages(int round) {
        String body = "第 " + round + " 轮正文" + "x".repeat(PAYLOAD_CHARS);
        return new ArrayList<>(List.of(UserMessageEntity.from(body)));
    }

    @Configuration
    static class Config {
        @Bean(destroyMethod = "shutdown")
        H2TestDatabase database() {
            return H2TestDatabase.create("SessionContextStorageFootprintTest");
        }

        @Bean
        PlatformTransactionManager transactionManager(H2TestDatabase database) {
            return new DataSourceTransactionManager(database);
        }

        @Bean
        SqlSessionTemplate sql(H2TestDatabase database) {
            return H2TestDatabase.sqlSession(database.sessionFactory(SessionContextMapper.class));
        }

        @Bean
        SessionContextMapper contexts(SqlSessionTemplate sql) {
            return sql.getMapper(SessionContextMapper.class);
        }

        @Bean
        SessionContextRepositoryImpl repository(SessionContextMapper contexts) {
            return new SessionContextRepositoryImpl(contexts);
        }

        @Bean
        ObjectMapper objectMapper() {
            return new JsonConfig().objectMapper();
        }

        @Bean
        LocalSessionContextFileStore store(ObjectMapper objectMapper) {
            // 正文目录放在系统临时目录：不在仓库工作区里落任何文件。
            return new LocalSessionContextFileStore(FOOTPRINT_DIR, objectMapper);
        }

        @Bean
        ModelContextService modelContextService(SessionContextRepositoryImpl repository,
                                                LocalSessionContextFileStore store) {
            return new ModelContextService(repository, store);
        }

        @Bean
        Path footprintDataDir() {
            return Path.of(FOOTPRINT_DIR);
        }
    }

    private static final String FOOTPRINT_DIR = System.getProperty("java.io.tmpdir")
            + "/lingxi-context-footprint-" + System.nanoTime();

    /** 用例产物落在系统临时目录，跑完自己收干净：不留在工作区，也不留给下一次。 */
    @AfterAll
    static void deleteFootprintDirectory() throws IOException {
        Path root = Path.of(FOOTPRINT_DIR);
        if (!Files.isDirectory(root)) {
            return;
        }
        try (Stream<Path> entries = Files.walk(root)) {
            for (Path path : entries.sorted(java.util.Comparator.reverseOrder()).toList()) {
                Files.deleteIfExists(path);
            }
        }
    }
}
