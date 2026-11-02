package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.SessionContext;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionContextPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 「替换正文前不读旧正文」的 SQLite 真库守卫。
 *
 * <p>装配层断言（{@code ModelContextServiceTest}）只能证明调用的是摘要方法，
 * 这里证明摘要查询**真的没有把 content 列选出来**：行里塞一段大正文，摘要返回对象的
 * {@code content} 必须是 {@code null}，而完整读取仍能拿到它。</p>
 */
class SessionContextSummaryQueryTest {

    private H2TestDatabase database;
    private SessionContextMapper mapper;
    private SessionContextRepositoryImpl repository;
    private ModelContextService service;
    private final ObjectMapper objectMapper = new JsonConfig().objectMapper();

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
        service = new ModelContextService(objectMapper, repository);
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
        assertNull(summary.get().getContent(), "摘要查询不能把正文列读出来");
        assertEquals(3L, summary.get().getVersion());
        // 对照：完整读取路径依然能拿到正文（不是把两条路都改成空）。
        assertEquals(huge, repository.findById(901L).orElseThrow().getContent());
    }

    @Test
    void replacingContentUsesTheSummaryVersionAndWritesTheNewBody() {
        mapper.insert(SessionContextPO.builder().sessionId(902L).content("[\"旧正文\"]").version(5L).build());

        service.replace(902L, List.of(UserMessageEntity.from("新正文")));

        SessionContextPO row = mapper.selectById(902L);
        assertEquals(6L, row.getVersion(), "版本仍按库里那一版 +1，行为与旧实现一致");
        assertTrue(row.getContent().contains("新正文"));
        assertTrue(!row.getContent().contains("旧正文"));
        assertNotNull(row.getUpdateTime());
    }
}
