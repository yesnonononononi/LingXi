package com.summit.dp.session.infrastructure.persistence.repository;

import com.summit.dp.session.application.port.SessionBulkClearPort;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.List;

/**
 * H2 会话与衍生数据全量清空适配器：
 * <ul>
 *   <li>库侧：按表各自在独立短事务（{@code REQUIRES_NEW}）中执行 {@code TRUNCATE TABLE}，
 *       彻底避免 N+1 查询与单一大事务持锁；</li>
 *   <li>配置保留：{@code mcp}、{@code provider_config}、{@code model_config}、{@code workspace}、
 *       {@code user_configs}、{@code agent}、{@code team}、{@code email}、{@code email_message}、
 *       {@code email_message_receipt}、{@code runtime_config_revision} 一律不动；</li>
 *   <li>磁盘侧：库表清空后再清理 {@code checkpoints}、{@code file-records}、{@code contexts}、
 *       {@code images} 下的全部子目录，顺带回收历史孤儿目录。</li>
 * </ul>
 */
@Component
@Slf4j
public class H2SessionBulkClearAdapter implements SessionBulkClearPort {

    /** 仅包含会话/执行/上下文/审计/文件记录/指令预测等可清空的派生表，严禁加入配置与敏感信息表。 */
    private static final List<String> CLEARABLE_TABLES = List.of(
            "session_message",
            "session_context",
            "session_token_audit_item",
            "session_token_audit",
            "chat_turn",
            "tool_call",
            "task",
            "checklist_step",
            "checklist",
            "execution_resume_task",
            "execution",
            "file_record",
            "instruction_predict",
            "session"
    );

    private static final List<String> CLEARABLE_DATA_DIRS = List.of(
            "checkpoints",
            "file-records",
            "contexts",
            "images"
    );

    private final DataSource dataSource;
    private final TransactionTemplate requiresNewTx;
    private final Path dataRoot;

    public H2SessionBulkClearAdapter(DataSource dataSource,
                                     PlatformTransactionManager transactionManager,
                                     @Value("${lingxi.data.dir}") String dataDir) {
        this.dataSource = dataSource;
        this.requiresNewTx = new TransactionTemplate(transactionManager);
        this.requiresNewTx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
        this.dataRoot = Path.of(dataDir).toAbsolutePath().normalize();
    }

    @Override
    public void clearAllSessionData() {
        for (String table : CLEARABLE_TABLES) {
            truncateInShortTransaction(table);
        }
        for (String dir : CLEARABLE_DATA_DIRS) {
            clearDirectoryContents(dataRoot.resolve(dir));
        }
        log.info("已完成 H2 会话及衍生数据全量清空: tables={}, dirs={}",
                CLEARABLE_TABLES.size(), CLEARABLE_DATA_DIRS);
    }

    private void truncateInShortTransaction(String table) {
        requiresNewTx.executeWithoutResult(status -> {
            Connection connection = DataSourceUtils.getConnection(dataSource);
            try (Statement statement = connection.createStatement()) {
                statement.execute("TRUNCATE TABLE " + table);
            } catch (SQLException e) {
                throw new IllegalStateException("清空表失败: table=" + table, e);
            } finally {
                DataSourceUtils.releaseConnection(connection, dataSource);
            }
        });
    }

    /** 清空目录下的所有子项，保留根目录本身。 */
    private void clearDirectoryContents(Path directory) {
        if (!Files.isDirectory(directory)) {
            return;
        }
        try (var children = Files.list(directory)) {
            for (Path child : children.toList()) {
                deleteRecursivelyQuietly(child);
            }
        } catch (IOException | RuntimeException e) {
            log.warn("枚举待清空数据目录失败，留待后续清理: dir={}, error={}", directory, e.toString());
        }
    }

    private void deleteRecursivelyQuietly(Path target) {
        try {
            Files.walkFileTree(target, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                    deleteQuietly(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException exc) {
                    deleteQuietly(dir);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException | RuntimeException e) {
            log.warn("删除残留目录项失败，留待后续清理: path={}, error={}", target, e.toString());
        }
    }

    private void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            log.warn("删除残留文件失败，留待后续清理: path={}, error={}", path, e.toString());
        }
    }
}
