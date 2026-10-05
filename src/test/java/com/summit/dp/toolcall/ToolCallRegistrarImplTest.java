package com.summit.dp.toolcall;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.toolcall.application.command.ToolCallRegisterCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.ToolCallRegistrarImpl;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * {@link ToolCallRegistrarImpl} 幂等 UPSERT 单测（QA 补充覆盖）。
 *
 * <p>证明设计 §5.2 的「关键顺序不变式」：同一 {@code callId} 先
 * {@code markExecuteStarted}（EXECUTE/in_progress）再 {@code registerPromise}（PROMISE/pending）
 * 后**只保留一行**且终态为 PROMISE/pending；{@code completeExecute} 对 PROMISE 行是 no-op；
 * 已存在行不会被 {@code markExecuteStarted} 降级。</p>
 *
 * <p>用内存假仓储（而非 Mockito 桩）真实断言「行数」与「整行终态」，而非仅校验方法被调用。</p>
 */
class ToolCallRegistrarImplTest {

    private FakeToolCallRepository repository;
    private ExecutionIdentity identity;
    private ToolCallRegistrarImpl registrar;

    @BeforeEach
    void setup() {
        repository = new FakeToolCallRepository();
        identity = mock(ExecutionIdentity.class);
        registrar = new ToolCallRegistrarImpl(repository, new ToolCallConverter(new ObjectMapper()), identity);
    }

    @Test
    void markThenPromiseUpsertsToExactlyOneRowInPendingPromise() {
        when(identity.sessionId("100")).thenReturn(5L);

        registrar.markExecuteStarted("call-x", 100L, "create_plan", "{}");
        assertEquals(1, repository.rowCount(), "EXECUTE 开始应先落一行占位");
        assertEquals(ToolCallType.EXECUTE, repository.findById("call-x").orElseThrow().getType());
        assertEquals(ToolCallStatus.IN_PROGRESS, repository.findById("call-x").orElseThrow().getStatus());

        registrar.registerPromise(ToolCallRegisterCommand.promise(
                "call-x", 5L, 100L, "create_plan", ToolCallKind.PLAN, "重构计划", "{\"kind\":\"PLAN\"}", "{\"args\":{}}"));

        assertEquals(1, repository.rowCount(), "同一 callId 只能有一行");
        ToolCall merged = repository.findById("call-x").orElseThrow();
        assertEquals(ToolCallType.PROMISE, merged.getType());
        assertEquals(ToolCallStatus.PREPARING, merged.getStatus());
        assertFalse(merged.isApprovalPending());
        assertEquals("create_plan", merged.getToolName());
        assertEquals("重构计划", merged.getTitle());
    }

    @Test
    void completeExecuteIsNoOpOnPromiseRow() {
        when(identity.sessionId("100")).thenReturn(5L);
        registrar.markExecuteStarted("call-y", 100L, "create_plan", "{}");
        registrar.registerPromise(ToolCallRegisterCommand.promise(
                "call-y", 5L, 100L, "create_plan", ToolCallKind.PLAN, "t", "{\"kind\":\"PLAN\"}", "{}"));

        registrar.completeExecute("call-y", 100L, "create_plan", "{}", "should-be-ignored", ToolCallOutcome.SUCCEEDED);

        ToolCall after = repository.findById("call-y").orElseThrow();
        assertEquals(ToolCallStatus.PREPARING, after.getStatus(), "PROMISE 的收尾交给 decide 端点");
        assertNull(after.getRawOutput());
        assertEquals(1, repository.rowCount());
    }

    @Test
    void markExecuteStartedDoesNotDowngradeExistingPromiseRow() {
        when(identity.sessionId("100")).thenReturn(5L);
        registrar.registerPromise(ToolCallRegisterCommand.promise(
                "call-z", 5L, 100L, "create_plan", ToolCallKind.PLAN, "t", "{\"kind\":\"PLAN\"}", "{}"));

        registrar.markExecuteStarted("call-z", 100L, "create_plan", "{}");

        ToolCall after = repository.findById("call-z").orElseThrow();
        assertEquals(ToolCallType.PROMISE, after.getType());
        assertEquals(ToolCallStatus.PREPARING, after.getStatus());
        assertEquals(1, repository.rowCount());
    }

    @Test
    void completeExecuteCompletesExecuteRow() {
        when(identity.sessionId("100")).thenReturn(5L);
        registrar.markExecuteStarted("call-exec", 100L, "read_file", "{\"path\":\"a\"}");

        registrar.completeExecute("call-exec", 100L, "read_file", "{\"path\":\"a\"}", "file-body",
                ToolCallOutcome.SUCCEEDED);

        ToolCall done = repository.findById("call-exec").orElseThrow();
        assertEquals(ToolCallType.EXECUTE, done.getType());
        assertEquals(ToolCallStatus.COMPLETED, done.getStatus());
        assertNotNull(done.getRawOutput());
        assertTrue(done.getRawOutput().contains("SUCCEEDED"));
        assertTrue(done.getRawOutput().contains("file-body"));
        assertEquals(1, repository.rowCount());
    }

    @Test
    void completeExecuteFallsBackToInsertWhenNoPlaceholderRow() {
        when(identity.sessionId("100")).thenReturn(5L);

        registrar.completeExecute("call-orphan", 100L, "create_plan", "{}", "out", ToolCallOutcome.SUCCEEDED);

        assertEquals(1, repository.rowCount());
        ToolCall fallback = repository.findById("call-orphan").orElseThrow();
        assertEquals(ToolCallType.EXECUTE, fallback.getType());
        assertEquals(ToolCallStatus.COMPLETED, fallback.getStatus());
    }

    @Test
    void markExecuteStartedSkipsWhenConversationCannotBeResolved() {
        when(identity.sessionId("100")).thenThrow(new IllegalStateException("Unknown execution"));

        registrar.markExecuteStarted("call-no-conv", 100L, "create_plan", "{}");

        assertEquals(0, repository.rowCount(), "无法定位会话时应降级跳过，不写脏行、不抛异常");
    }

    /** 内存假仓储：真实维护「行」，供断言「只有一行 / 整行终态」而非仅校验方法调用。 */
    private static final class FakeToolCallRepository implements ToolCallRepository {

        private final Map<String, ToolCall> rows = new LinkedHashMap<>();

        int rowCount() {
            return rows.size();
        }

        @Override
        public Optional<ToolCall> findById(String id) {
            return Optional.ofNullable(rows.get(id));
        }

        @Override
        public void save(ToolCall model) {
            rows.put(model.getId(), model);
        }

        @Override
        public void delete(ToolCall model) {
            rows.remove(model.getId());
        }

        @Override
        public void updateById(ToolCall model) {
            rows.put(model.getId(), model);
        }

        @Override
        public void update(Collection<ToolCall> models) {
            models.forEach(this::updateById);
        }

        @Override
        public IPage<ToolCall> queryByPage(int current, int size) {
            return null;
        }

        @Override
        public List<ToolCall> listByIds(Collection<String> ids) {
            List<ToolCall> found = new ArrayList<>();
            for (String id : ids) {
                ToolCall row = rows.get(id);
                if (row != null) {
                    found.add(row);
                }
            }
            return found;
        }

        @Override
        public List<ToolCall> listByConversationId(Long conversationId) {
            return rows.values().stream().filter(row -> row.getConversationId().equals(conversationId)).toList();
        }

        @Override
        public List<ToolCall> listByExecutionId(Long executionId) {
            return rows.values().stream().filter(row -> row.getExecutionId().equals(executionId)).toList();
        }

        @Override
        public List<ToolCall> listActionableByExecutionId(Long executionId) {
            return listByExecutionId(executionId).stream().filter(ToolCall::isApprovalPending).toList();
        }

        @Override
        public List<Long> listUnresolvedExecutionIds() { return List.of(); }

        @Override
        public List<ToolCall> listPendingByExecutionId(Long executionId) {
            return rows.values().stream()
                    .filter(row -> row.getExecutionId().equals(executionId)
                            && row.getStatus() == ToolCallStatus.PENDING)
                    .toList();
        }

        @Override
        public List<ToolCall> listPendingByConversationId(Long conversationId) {
            return rows.values().stream()
                    .filter(row -> row.getConversationId().equals(conversationId)
                            && row.getStatus() == ToolCallStatus.PENDING)
                    .toList();
        }

        @Override
        public boolean existsById(String id) {
            return rows.containsKey(id);
        }

        @Override
        public long countByConversationId(Long conversationId) {
            return listByConversationId(conversationId).size();
        }

        @Override
        public int deleteByConversationIds(Collection<Long> conversationIds) {
            List<String> doomed = rows.values().stream()
                    .filter(row -> conversationIds.contains(row.getConversationId()))
                    .map(ToolCall::getId)
                    .toList();
            doomed.forEach(rows::remove);
            return doomed.size();
        }

        @Override
        public int deleteByExecutionIds(Collection<Long> executionIds) {
            List<String> doomed = rows.values().stream()
                    .filter(row -> row.getExecutionId() != null
                            && executionIds.contains(row.getExecutionId()))
                    .map(ToolCall::getId)
                    .toList();
            doomed.forEach(rows::remove);
            return doomed.size();
        }

        @Override
        public void bindSessionMessage(String toolCallId, Long sessionMessageId) {
            ToolCall row = rows.get(toolCallId);
            if (row != null && sessionMessageId != null) {
                row = row.toBuilder().sessionMessageId(sessionMessageId).build();
                rows.put(toolCallId, row);
            }
        }
    }
}
