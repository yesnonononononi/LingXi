package com.summit.dp.session;

import com.summit.dp.session.infrastructure.persistence.repository.H2SessionBulkClearAdapter;
import com.summit.dp.shared.support.H2TestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 真 H2 + 真磁盘目录验证：全量清空只清会话与执行衍生数据，保留团队/智能体/用户/模型/MCP/工作空间等配置表。
 */
class H2SessionBulkClearIntegrationTest {

    private H2TestDatabase database;
    private Path dataDir;
    private H2SessionBulkClearAdapter adapter;

    @BeforeEach
    void setUp() throws Exception {
        database = H2TestDatabase.create("SessionBulkClearIntegrationTest");
        dataDir = Files.createTempDirectory("lingxi-bulk-clear-");
        adapter = new H2SessionBulkClearAdapter(
                database,
                new DataSourceTransactionManager(database),
                dataDir.toString());
    }

    @AfterEach
    void tearDown() throws Exception {
        if (database != null) {
            database.close();
        }
        if (dataDir != null && Files.exists(dataDir)) {
            try (Stream<Path> walk = Files.walk(dataDir)) {
                walk.sorted(Comparator.reverseOrder()).forEach(path -> {
                    try {
                        Files.deleteIfExists(path);
                    } catch (Exception ignored) {
                    }
                });
            }
        }
    }

    @Test
    void clearsAllSessionAndExecutionTablesAndDirectoriesWhilePreservingConfigs() throws Exception {
        // 1. 插入重要配置与敏感信息表
        database.execute("INSERT INTO provider_config (id, name, api_key) VALUES (1, 'openai', 'sk-secret')");
        database.execute("INSERT INTO model_config (id, model_name, base_url, api_key) VALUES (1, 'gpt-4o', 'https://api.openai.com', 'sk-secret')");
        database.execute("INSERT INTO agent (id, name, prompt) VALUES (1, 'coder', 'You are a coder')");
        database.execute("INSERT INTO team (id, name) VALUES (1, 'core-team')");
        database.execute("INSERT INTO user_configs (id, render_theme) VALUES (1, 'DARK')");
        database.execute("INSERT INTO mcp (id, name) VALUES (1, 'github')");
        database.execute("INSERT INTO workspace (id, name, host_dir) VALUES (1, 'repo', '/ws')");

        // 2. 插入会话、执行、检查点、文件记录、上下文、审计、预测等衍生表
        database.execute("INSERT INTO session (id, name) VALUES (10, 's1')");
        database.execute("INSERT INTO session_message (id, session_id, type, content) VALUES (100, 10, 'USER', 'hi')");
        database.execute("INSERT INTO session_context (session_id, content) VALUES (10, 'ctx')");
        database.execute("INSERT INTO session_token_audit (session_id, execution_id) VALUES (10, 500)");
        database.execute("INSERT INTO session_token_audit_item (id, session_id, item_level, category) VALUES (201, 10, 1, 'SYSTEM')");
        database.execute("INSERT INTO chat_turn (id, session_id) VALUES (300, 10)");
        database.execute("INSERT INTO tool_call (id, conversation_id, execution_id, tool_name, type, status) VALUES ('tc1', 10, 500, 'read', 'TOOL', 'COMPLETED')");
        database.execute("INSERT INTO task (id, session_id, turn_id, command_text, status, create_at) VALUES (600, 10, 300, 'echo hi', 'COMPLETED', CURRENT_TIMESTAMP)");
        database.execute("INSERT INTO checklist (id, session_id, title, status, create_at, update_at) VALUES (700, 10, 'cl', 'COMPLETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)");
        database.execute("INSERT INTO checklist_step (id, checklist_id, seq, content, status, update_at) VALUES (701, 700, 1, 'step1', 'DONE', CURRENT_TIMESTAMP)");
        database.execute("INSERT INTO execution (id, session_id, status, snapshot_file) VALUES (500, 10, 2, 'abc.json')");
        database.execute("INSERT INTO execution_resume_task (id, execution_id, generation, state) VALUES (800, 500, 1, 'DONE')");
        database.execute("INSERT INTO file_record (id, execution_id, version, file_path, diff, create_at) VALUES ('fr1', '500', 1, 'a.txt', 'diff', CURRENT_TIMESTAMP)");
        database.execute("INSERT INTO instruction_predict (session_id, turn_id, next_instruction) VALUES (10, 300, 'next')");

        // 3. 创建对应的磁盘目录与文件
        for (String rel : List.of(
                "checkpoints/500/abc.json",
                "file-records/500/fr1.baseline",
                "contexts/10/ctx.json",
                "images/10/img.png")) {
            Path file = dataDir.resolve(rel);
            Files.createDirectories(file.getParent());
            Files.writeString(file, "payload");
        }

        // 执行全量清空
        adapter.clearAllSessionData();

        // 4. 验证 14 张会话/执行/衍生表全部清空
        for (String table : List.of(
                "session", "session_message", "session_context",
                "session_token_audit", "session_token_audit_item",
                "chat_turn", "tool_call", "task", "checklist", "checklist_step",
                "execution", "execution_resume_task", "file_record", "instruction_predict")) {
            assertEquals("0", database.queryString("SELECT COUNT(1) FROM " + table),
                    "表应已清空: " + table);
        }

        // 5. 验证 4 个磁盘目录全部清空（根目录保留、内部无残留）
        for (String dir : List.of("checkpoints", "file-records", "contexts", "images")) {
            try (Stream<Path> children = Files.list(dataDir.resolve(dir))) {
                assertTrue(children.findAny().isEmpty(), "目录应已清空: " + dir);
            }
        }

        // 6. 验证重要配置与敏感信息表完整保留
        for (String configTable : List.of(
                "provider_config", "model_config", "agent", "team", "user_configs", "mcp", "workspace")) {
            assertEquals("1", database.queryString("SELECT COUNT(1) FROM " + configTable),
                    "配置表不得被清空: " + configTable);
        }
    }
}
