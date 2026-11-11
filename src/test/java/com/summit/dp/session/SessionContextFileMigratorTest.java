package com.summit.dp.session;

import com.summit.dp.session.application.port.SessionContextStore;
import com.summit.dp.session.infrastructure.context.LocalSessionContextFileStore;
import com.summit.dp.session.infrastructure.context.SessionContextFileMigrator;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.UserMessageEntity;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mybatis.spring.SqlSessionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 历史正文外置迁移：库里那批 {@code snapshot_file IS NULL} 的老行必须在启动时搬成文件并置空 CLOB。
 *
 * <p>关键断言是「搬完库内 content 变 NULL、文件里能读回同一份内容」——
 * 少任何一边，旧会话打开都会看不到历史。</p>
 */
class SessionContextFileMigratorTest {

    private H2TestDatabase database;
    private SessionContextMapper mapper;
    private SessionContextStore store;
    private final ObjectMapper objectMapper = new JsonConfig().objectMapper();

    @TempDir
    Path dataDir;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionContextFileMigratorTest");
        SqlSessionTemplate sql = H2TestDatabase.sqlSession(
                database.sessionFactory(SessionContextMapper.class));
        mapper = sql.getMapper(SessionContextMapper.class);
        store = new LocalSessionContextFileStore(dataDir.toString(), objectMapper);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    void migratesLegacyContentIntoAFileAndClearsTheColumn() throws Exception {
        // 旧正文必须用同一套序列化造出来，手写 JSON 只会测到自己的拼写。
        String legacy = objectMapper.writeValueAsString(List.of(UserMessageEntity.from("旧历史")));
        mapper.insert(SessionContextPO.builder().sessionId(801L).content(legacy).version(4L).build());

        new SessionContextFileMigrator(mapper, store, objectMapper).run(null);

        SessionContextPO row = mapper.selectById(801L);
        assertNotNull(row.getSnapshotFile(), "迁移后库里必须留下正文标识");
        assertNull(row.getContent(), "迁移后库内旧正文必须置空");
        assertEquals(4L, row.getVersion(), "迁移不是一次替换，版本不动");

        List<com.summit.core.conversation.message.Message> restored =
                store.read(801L, row.getSnapshotFile());
        assertEquals(1, restored.size());
        assertEquals("旧历史", restored.get(0).text());
    }

    /** 抢在迁移前面完成的 replace 会让条件更新命中 0 行：此时刚写出的文件没人会读到，必须当场删掉。 */
    @Test
    void losesTheRaceAgainstReplaceAndLeavesNoOrphanFile() throws Exception {
        mapper.insert(SessionContextPO.builder().sessionId(804L)
                .content(objectMapper.writeValueAsString(List.of(UserMessageEntity.from("旧历史"))))
                .version(1L).build());
        SessionContextMapper racing = org.mockito.Mockito.spy(mapper);
        org.mockito.Mockito.doReturn(0).when(racing).assignSnapshotFile(org.mockito.ArgumentMatchers.anyLong(),
                org.mockito.ArgumentMatchers.anyString());

        new SessionContextFileMigrator(racing, store, objectMapper).run(null);

        Path directory = dataDir.resolve("session-context").resolve("804");
        if (Files.isDirectory(directory)) {
            try (var files = Files.list(directory)) {
                assertEquals(0, files.count(), "抢输的那份正文不能留成孤儿文件");
            }
        }
    }

    /** 解析不了的行留在库里等下次启动，不能因为一行坏数据让整个迁移停住。 */
    @Test
    void unparsableRowStaysInTheDatabaseAndDoesNotBlockOthers() throws Exception {
        mapper.insert(SessionContextPO.builder().sessionId(802L).content("不是 JSON").version(1L).build());
        mapper.insert(SessionContextPO.builder().sessionId(803L)
                .content(objectMapper.writeValueAsString(List.of(UserMessageEntity.from("好行"))))
                .version(1L).build());

        new SessionContextFileMigrator(mapper, store, objectMapper).run(null);

        assertEquals("不是 JSON", mapper.selectById(802L).getContent(), "坏行原样留着");
        assertNull(mapper.selectById(802L).getSnapshotFile());
        assertNull(mapper.selectById(803L).getContent(), "后面的好行不能被坏行挡住");
        assertNotNull(mapper.selectById(803L).getSnapshotFile());
    }
}
