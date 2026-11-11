package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.infrastructure.context.LocalSessionContextFileStore;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mybatis.spring.SqlSessionTemplate;

import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 「替换正文前不读旧正文」的真库守卫。
 *
 * <p>装配层断言（{@code ModelContextServiceTest}）只能证明调用的是摘要方法，
 * 这里证明摘要查询**真的没有把 content 列选出来**：行里塞一段大正文，摘要返回对象的
 * {@code content} 必须是 {@code null}（迁移期的旧正文仍在库里），而完整读取仍能拿到它。</p>
 */
class SessionContextSummaryQueryTest {

    private H2TestDatabase database;
    private SessionContextMapper mapper;
    private SessionContextRepositoryImpl repository;
    private ModelContextService service;
    private final ObjectMapper objectMapper = new JsonConfig().objectMapper();

    @TempDir
    Path dataDir;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionContextSummaryQueryTest");
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        MyBatisTypeHandlers.registerAll(configuration);
        configuration.addMapper(SessionContextMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionTemplate sql = H2TestDatabase.sqlSession(factory.getObject());
        mapper = sql.getMapper(SessionContextMapper.class);
        repository = new SessionContextRepositoryImpl(mapper);
        service = new ModelContextService(repository,
                new LocalSessionContextFileStore(dataDir.toString(), objectMapper));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    void summaryQueryLeavesTheContentColumnUnread() {
        String huge = "x".repeat(256 * 1024);
        mapper.insert(SessionContextPO.builder().sessionId(901L).content(huge).version(3L).build());

        Optional<SessionContext> summary = repository.findSummary(901L);

        assertTrue(summary.isPresent());
        assertEquals(3L, summary.get().getVersion());
        assertNull(summary.get().getSnapshotFile(), "还没迁移的行没有正文标识");
        // 对照：正文仍在库里（迁移前的事实没被摘要查询破坏），只是领域模型不再携带它。
        assertEquals(huge, mapper.selectById(901L).getContent());
    }

    @Test
    void replacingContentUsesTheSummaryVersionAndWritesTheNewBodyOutOfTheDatabase() {
        mapper.insert(SessionContextPO.builder().sessionId(902L).content("[\"旧正文\"]").version(5L).build());

        service.replace(902L, List.of(UserMessageEntity.from("新正文")));

        SessionContextPO row = mapper.selectById(902L);
        assertEquals(6L, row.getVersion(), "版本仍按库里那一版 +1，行为与旧实现一致");
        assertNotNull(row.getSnapshotFile(), "库里必须记下正文标识");
        assertNull(row.getContent(), "新正文不得再写进 CLOB 列");
        assertNotNull(row.getUpdateTime());

        List<Message> restored = service.find(902L).orElseThrow();
        assertEquals(1, restored.size());
        assertEquals("新正文", restored.get(0).text());
    }
}
