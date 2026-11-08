package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.session.domain.model.SessionTokenAudit;
import com.summit.dp.session.domain.model.TokenAuditGroupKind;
import com.summit.dp.session.domain.model.TokenAuditPersistedState;
import com.summit.dp.session.domain.model.TokenAuditReconciler;
import com.summit.dp.session.domain.model.TokenAuditReconciler.GroupMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.ItemMeasurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Measurement;
import com.summit.dp.session.domain.model.TokenAuditReconciler.Result;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionTokenAuditItemMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionTokenAuditMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionTokenAuditRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 审计快照仓储的真 H2 用例：头表 upsert、明细「先删后插」、失败不覆盖成功快照。
 *
 * <p>用真库而不是 mock：本仓储的难点全在 SQL 语义上（{@code update} 能否把列写回 NULL、
 * 旧工具名会不会残留），mock 只能证明「调了几次方法」，证明不了这些。</p>
 */
class SessionTokenAuditRepositoryTest {

    private static final long SESSION_ID = 900001L;
    private static final Instant CAPTURED_AT = Instant.parse("2026-11-07T02:15:33.412Z");

    private H2TestDatabase database;
    private SessionTokenAuditRepositoryImpl repository;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionTokenAuditRepositoryTest");
        MybatisConfiguration configuration = database.configuration(
                SessionTokenAuditMapper.class, SessionTokenAuditItemMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        repository = new SessionTokenAuditRepositoryImpl(
                H2TestDatabase.sqlSession(sessionFactory).getMapper(SessionTokenAuditMapper.class),
                H2TestDatabase.sqlSession(sessionFactory).getMapper(SessionTokenAuditItemMapper.class));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("首次写入：头表 + 明细一次落全，读回后恒等式与比率可用")
    void firstWriteStoresHeadAndItems() {
        repository.replaceSnapshot(collected(List.of("search_web", "read_file")));

        SessionTokenAudit loaded = repository.findBySessionId(SESSION_ID).orElseThrow();
        assertEquals(TokenAuditPersistedState.COLLECTED, loaded.getState());
        assertEquals(148200, loaded.getTotalTokens());
        assertEquals(200000, loaded.getMaxTokens());
        assertEquals(126650, loaded.getMessagesTokens());
        assertEquals(21550, loaded.getRequestOverheadTokens());
        assertEquals(5900, loaded.getOverlapTokens());
        // 本夹具：框架自报工具总量 63614，各分组展示值之和 = MCP 34700 + Skill 14200 + 普通 8000
        // = 56900，故漂移 = 6714。断言它读回仍是 6714，证明新列真的落库了（否则会读成 null/0）。
        assertEquals(6714, loaded.getToolGroupingDrift(),
                "归因漂移必须跟着快照落库（V6 新增列），否则这条绊线读库即丢");
        assertEquals(9, loaded.getItems().size(), "4 消息 + 3 分组 + 2 工具名");
        assertEquals(2, loaded.toolItems().size());
        // 框架 e9c6ec6：工具定义两项必须落库并读回真值（未知才会是 null）。
        assertEquals(8200, loaded.getToolDefinitionTokens());
        assertEquals(3100, loaded.getMcpToolDefinitionTokens());
        assertEquals(21550 - 8200 - 3100, loaded.framingResidualTokens(),
                "残差由落库值现算，读回后必须与采集期一致");
        assertEquals("1", database.queryString("SELECT COUNT(*) FROM session_token_audit"),
                "头表一个会话只能有一行");
        assertEquals("0", database.queryString(
                "SELECT COUNT(*) FROM session_token_audit WHERE fail_reason IS NOT NULL"));
        assertEquals("0", database.queryString(
                "SELECT COUNT(*) FROM session_token_audit"
                        + " WHERE tool_definition_tokens IS NULL OR mcp_tool_definition_tokens IS NULL"),
                "本夹具两项已知，库里不允许出现 NULL");
    }

    @Test
    @DisplayName("再次写入：明细先删后插，上一轮独有的工具名不得残留")
    void secondWriteReplacesItemsWithoutResidue() {
        repository.replaceSnapshot(collected(List.of("search_web", "read_file")));
        repository.replaceSnapshot(collected(List.of("execute_command")));

        SessionTokenAudit loaded = repository.findBySessionId(SESSION_ID).orElseThrow();
        assertEquals(1, loaded.toolItems().size(), "上一轮的两个工具名必须被删掉");
        assertEquals("execute_command", loaded.toolItems().getFirst().getToolName());
        assertEquals("1", database.queryString("SELECT COUNT(*) FROM session_token_audit"));
        assertEquals("0", database.queryString(
                "SELECT COUNT(*) FROM session_token_audit_item WHERE tool_name = 'search_web'"),
                "删旧明细必须真的删掉，而不是留着旧行");
    }

    @Test
    @DisplayName("失败标记：无快照时落 FAILED，数值清空、原因截断到 512 字符")
    void markFailedCreatesFailedRow() {
        String reason = "AUDIT_ERROR: " + "错".repeat(600);

        repository.markFailed(SESSION_ID, 9L, reason);

        SessionTokenAudit loaded = repository.findBySessionId(SESSION_ID).orElseThrow();
        assertEquals(TokenAuditPersistedState.FAILED, loaded.getState());
        assertNull(loaded.getTotalTokens());
        assertEquals(SessionTokenAudit.MAX_FAIL_REASON_LENGTH, loaded.getFailReason().length(),
                "库列宽是 512 字符，必须按字符截断（按字节会切出半个汉字）");
        assertEquals(9L, loaded.getExecutionId());
        assertTrue(loaded.getItems().isEmpty(), "失败态不带明细行");
    }

    @Test
    @DisplayName("失败不得覆盖已有 COLLECTED 快照（硬规则）")
    void markFailedKeepsCollectedSnapshot() {
        repository.replaceSnapshot(collected(List.of("search_web", "read_file")));

        repository.markFailed(SESSION_ID, 9L, "AUDIT_ERROR: 偶发失败");

        SessionTokenAudit loaded = repository.findBySessionId(SESSION_ID).orElseThrow();
        assertEquals(TokenAuditPersistedState.COLLECTED, loaded.getState(), "状态必须保持 COLLECTED");
        assertEquals(148200, loaded.getTotalTokens(), "数值必须原样保留");
        assertNull(loaded.getFailReason(), "不得把失败原因写进成功快照");
        assertEquals(9, loaded.getItems().size(), "明细行必须原样保留");
    }

    @Test
    @DisplayName("upsert 允许把上一轮的 fail_reason 与数值写回 NULL（整行替换而非打补丁）")
    void upsertClearsStaleColumns() {
        repository.markFailed(SESSION_ID, 9L, "AUDIT_ERROR: 先失败一次");
        repository.replaceSnapshot(collected(List.of("search_web")));

        SessionTokenAudit loaded = repository.findBySessionId(SESSION_ID).orElseThrow();
        assertEquals(TokenAuditPersistedState.COLLECTED, loaded.getState());
        assertNull(loaded.getFailReason(), "上一轮的失败原因必须被清掉");
        assertEquals("0", database.queryString(
                "SELECT COUNT(*) FROM session_token_audit WHERE fail_reason IS NOT NULL"));
    }

    @Test
    @DisplayName("读不存在的会话返回空，不抛异常")
    void missingSessionReturnsEmpty() {
        assertEquals(Optional.empty(), repository.findBySessionId(SESSION_ID));
        assertEquals(Optional.empty(), repository.findBySessionId(null));
    }

    /** 一个自洽的成功快照（新口径：工具总量不含参数），工具名清单可切换以验证删旧插新。 */
    @Test
    @DisplayName("归因明细列：两值非空时往返一致，且不改变任何合计")
    void attributionColumnsRoundTrip() {
        repository.replaceSnapshot(collected(List.of("search_web"), 777, 889));

        SessionTokenAudit loaded = repository.findBySessionId(SESSION_ID).orElseThrow();
        assertEquals(777, loaded.getMemoryTokens(), "记忆正文 token 必须跟着快照落库");
        assertEquals(889, loaded.getAttachmentTokens(), "附件 token 必须跟着快照落库");
        // 归因明细不进任何合计：读回后的三条恒等式与不带它们时完全一致。
        assertEquals(122650, loaded.getMessagesTokens());
        assertEquals(148200, loaded.getTotalTokens());
        assertEquals(25550, loaded.getRequestOverheadTokens());
        assertEquals(loaded.getTotalTokens(),
                loaded.getMessagesTokens() + loaded.getRequestOverheadTokens());
        assertEquals("0", database.queryString(
                "SELECT COUNT(*) FROM session_token_audit WHERE memory_tokens IS NULL"
                        + " OR attachment_tokens IS NULL"),
                "本夹具两项已知，库里不允许出现 NULL");
    }

    @Test
    @DisplayName("归因明细列可空：未知写 NULL 而不是 0，且能被 upsert 重新写回 NULL")
    void attributionColumnsStayNullableAndCanBeCleared() {
        repository.replaceSnapshot(collected(List.of("search_web"), 777, 889));
        repository.replaceSnapshot(collected(List.of("search_web"), null, null));

        SessionTokenAudit loaded = repository.findBySessionId(SESSION_ID).orElseThrow();
        assertNull(loaded.getMemoryTokens(), "未知必须读回 null，绝不能被写成 0");
        assertNull(loaded.getAttachmentTokens());
        assertEquals("1", database.queryString(
                "SELECT COUNT(*) FROM session_token_audit"
                        + " WHERE memory_tokens IS NULL AND attachment_tokens IS NULL"),
                "整行替换必须能把上一轮的值写回 NULL（这正是 updateById 做不到的地方）");
        // 只清空归因列，其余列不受影响。
        assertEquals(122650, loaded.getMessagesTokens());
        assertEquals(8200, loaded.getToolDefinitionTokens());
    }

    @Test
    @DisplayName("失败快照：归因列必须为 NULL（失败就是不知道，不用 0 冒充）")
    void failedSnapshotHasNullAttribution() {
        repository.replaceSnapshot(collected(List.of("search_web"), 777, 889));
        repository.markFailed(SESSION_ID, 9L, "AUDIT_ERROR: 采集失败");

        // 已有成功快照时失败不覆盖，因此先单独验一个全新会话的失败行。
        long freshSession = SESSION_ID + 1;
        repository.markFailed(freshSession, 9L, "AUDIT_ERROR: 采集失败");
        SessionTokenAudit failed = repository.findBySessionId(freshSession).orElseThrow();

        assertEquals(TokenAuditPersistedState.FAILED, failed.getState());
        assertNull(failed.getMemoryTokens());
        assertNull(failed.getAttachmentTokens());
        assertEquals("1", database.queryString(
                "SELECT COUNT(*) FROM session_token_audit WHERE audit_state = 'FAILED'"
                        + " AND memory_tokens IS NULL AND attachment_tokens IS NULL"));
    }

    private static SessionTokenAudit collected(List<String> toolNames) {
        return collected(toolNames, null, null);
    }

    /**
     * 同上的成功快照，但显式指定两个归因明细值。
     *
     * @param toolNames        工具名清单
     * @param memoryTokens     记忆正文 token；null 表示未知
     * @param attachmentTokens 附件 token；null 表示未知
     * @return 快照
     */
    private static SessionTokenAudit collected(List<String> toolNames, Integer memoryTokens,
                                               Integer attachmentTokens) {
        int ordinary = 0;
        List<ItemMeasurement> items = new java.util.ArrayList<>();
        for (String name : toolNames) {
            items.add(new ItemMeasurement(name, 4000, 300, 3700, 1));
            ordinary += 4000;
        }
        GroupMeasurement ordinaryGroup = new GroupMeasurement(TokenAuditGroupKind.ORDINARY, ordinary,
                items.size() * 300, ordinary - items.size() * 300, items.size(), items);
        Measurement measurement = new Measurement(12300, 18450, 39000, 63614, 5900, 148200, 200000,
                List.of(new GroupMeasurement(TokenAuditGroupKind.MCP, 34700, 2100, 33000, 12, List.of()),
                        new GroupMeasurement(TokenAuditGroupKind.SKILL, 14200, 800, 13000, 3,
                                List.of()),
                        ordinaryGroup),
                8200, 3100, memoryTokens, attachmentTokens);
        Result result = TokenAuditReconciler.reconcile(measurement);
        return SessionTokenAudit.capture(SESSION_ID, 1L, result, CAPTURED_AT);
    }
}
