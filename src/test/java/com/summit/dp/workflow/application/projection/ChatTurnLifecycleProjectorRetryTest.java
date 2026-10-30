package com.summit.dp.workflow.application.projection;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import java.lang.reflect.Field;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/**
 * 轮次投影的整笔重试：锁冲突换新事务重放，业务失败不重放。
 *
 * <p>被守的缺陷与 {@code ModelContextService.replace} 同一类：投影是「读轮次 → 改状态 → 写回」，
 * 同一排空周期里多个执行并发投影时，后写的一方在 SQLite 上会撞 {@code SQLITE_BUSY_SNAPSHOT}。
 * 只重试 UPDATE 无效，必须整笔换新事务。</p>
 */
class ChatTurnLifecycleProjectorRetryTest {

    /** 锁冲突后重试：终态投影第二次成功，且重放用的不是同一次调用。 */
    @Test
    @Timeout(60)
    void terminalProjectionRetriesLockConflict() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("turn-projector-retry");
        try {
            ChatTurnService chatTurn = mock(ChatTurnService.class);
            doThrow(new CannotAcquireLockException("模拟 SQLITE_BUSY_SNAPSHOT"))
                    .doNothing()
                    .when(chatTurn).markTerminal(any(), any(), any(), any(), any(), any(), any());

            projector(chatTurn, database).finishExecution(execution(ExecutionState.COMPLETED));

            verify(chatTurn, times(2)).markTerminal(eq("940001"), eq(ChatTurnStatus.COMPLETED),
                    any(), any(), any(), any(), any());
        } finally {
            database.shutdown();
        }
    }

    /** 业务失败不重试：状态机违约等真实错误必须原样抛出，不能被重放掩盖。 */
    @Test
    @Timeout(60)
    void businessFailureIsNotRetried() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("turn-projector-business");
        try {
            ChatTurnService chatTurn = mock(ChatTurnService.class);
            doThrow(new IllegalStateException("状态机违约"))
                    .when(chatTurn).markWaiting(any(), any());

            ChatTurnLifecycleProjector projector = projector(chatTurn, database);
            assertThrows(IllegalStateException.class, () -> projector.markExecutionWaiting(
                    execution(ExecutionState.SUSPENDED)));

            verify(chatTurn, times(1)).markWaiting(any(), any());
        } finally {
            database.shutdown();
        }
    }

    /** 非终态（如 RUNNING）不投影终态：与改造前一致，不因重试包装而多发一次写入。 */
    @Test
    @Timeout(60)
    void nonTerminalStateIsNotProjected() throws Exception {
        SqliteTestDatabase database = SqliteTestDatabase.create("turn-projector-non-terminal");
        try {
            ChatTurnService chatTurn = mock(ChatTurnService.class);
            projector(chatTurn, database).finishExecution(execution(ExecutionState.RUNNING));

            verify(chatTurn, times(0)).markTerminal(any(), any(), any(), any(), any(), any(), any());
        } finally {
            database.shutdown();
        }
    }

    private static ChatTurnLifecycleProjector projector(ChatTurnService chatTurn, SqliteTestDatabase database)
            throws Exception {
        ChatTurnLifecycleProjector projector = new ChatTurnLifecycleProjector(chatTurn);
        // 与 Spring 注入的是同一个字段：只有它是真实事务管理器时，重试才会逐次开新事务。
        Field field = ChatTurnLifecycleProjector.class.getDeclaredField("transactionManager");
        field.setAccessible(true);
        field.set(projector, new DataSourceTransactionManager(database));
        return projector;
    }

    private static Execution execution(ExecutionState state) {
        return Execution.builder()
                .id("940001")
                .executionState(state)
                .agentRequest(com.summit.core.agent.AgentRequest.builder()
                        .executionId("940001")
                        .messages(new java.util.ArrayList<>())
                        .build())
                .build();
    }
}
