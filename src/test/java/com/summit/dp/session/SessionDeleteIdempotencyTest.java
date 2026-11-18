package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 删除必须幂等：目标已经不在时，解析树只能返空，绝不能抛「会话不存在」。
 *
 * <p>这不是理论洁癖：入口把它当失败之后，侧栏残留的幽灵行就再也删不掉了 ——
 * 点一次弹一次「删除会话失败」，而库里根本没有这行可删。</p>
 */
class SessionDeleteIdempotencyTest {

    private H2TestDatabase database;
    private SessionRepositoryImpl repository;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionDeleteIdempotencyTest");
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        MyBatisTypeHandlers.registerAll(configuration);
        configuration.addMapper(SessionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionTemplate sql = H2TestDatabase.sqlSession(factory.getObject());
        repository = new SessionRepositoryImpl(sql.getMapper(SessionMapper.class));
    }

    @AfterEach
    void tearDown() {
        if (database != null) {
            database.close();
        }
    }

    @Test
    void resolveTreeIdsReturnsEmptyForMissingSessionInsteadOfThrowing() {
        List<Long> ids = repository.resolveTreeIds(999_999L);

        assertTrue(ids.isEmpty(), "目标不存在时解析结果必须是空列表（删除幂等的判据）");
    }

    @Test
    void resolveTreeIdsReturnsEmptyForNullId() {
        assertTrue(repository.resolveTreeIds(null).isEmpty(), "空 id 不该被当成一次失败");
    }

    /** 正对照：真的存在时仍要解析出整棵树，别把「幂等」写成「永远返空」。 */
    @Test
    void resolveTreeIdsStillResolvesExistingTree() {
        repository.save(Session.builder().id(7001L).name("根会话").build());

        assertEquals(List.of(7001L), repository.resolveTreeIds(7001L));
    }

    /** 用例自身的体检：save 之后必须真的查得到，否则上面那条正对照可能假绿。 */
    @Test
    void savedSessionIsVisibleToFindExistingIds() {
        repository.save(Session.builder().id(7002L).name("根会话2").build());

        assertEquals(List.of(7002L), repository.findExistingIds(List.of(7002L)));
    }
}
