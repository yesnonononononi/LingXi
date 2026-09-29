package com.summit.dp.session;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.session.application.convert.SessionMessageViewAssembler;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 读路径「转换 + 一次批量装载」查询服务单测（对应 PRD C1 / P0-4 / P2-1，评审 P1-③）。
 *
 * <p>证明设计 §7.1 的「单页 {@code tool_call} 查询恒为 1 次」不变式：一页含多处工具调用，
 * {@link SessionMessageQueryService#query} 内部只触发**一次**批量 {@code IN} 查询（先对 callId 去重）；
 * 并证明「{@code tool_call} 缺行时消息不丢、不抛异常、{@code toolCall} 为 null」的诚实降级。
 * 转换与装载显式串联在一个方法内，杜绝漏调。</p>
 */
class SessionMessageQueryServiceTest {

    private CountingToolCallRepository repository;
    private SessionMessageQueryService queryService;

    @BeforeEach
    void setup() {
        ObjectMapper mapper = new ObjectMapper();
        repository = new CountingToolCallRepository();
        SessionMessageViewAssembler assembler = new SessionMessageViewAssembler(mapper, new ToolCallConverter(mapper));
        queryService = new SessionMessageQueryService(assembler, repository, new ToolCallConverter(mapper));
    }

    @Test
    void queryIssuesExactlyOneBatchQueryForAPageWithManyToolCalls() {
        List<SessionMessage> page = new ArrayList<>();
        int distinctCalls = 20;
        for (int i = 0; i < distinctCalls; i++) {
            String callId = "call_" + i;
            page.add(toolMessage(1000L + i, callId));
            repository.save(toolCall(callId, 7L, 70L));
        }
        // 页尾再重复两个已出现的 callId，验证装载前先去重再查询。
        page.add(toolMessage(2000L, "call_0"));
        page.add(toolMessage(2001L, "call_1"));

        SessionMessageQueryService.SessionMessageQueryResult result = queryService.query(page);

        assertEquals(1, repository.listByIdsInvocations, "单页 tool_call 批量查询次数必须恒为 1");
        assertEquals(distinctCalls, repository.lastRequestedIds.size(), "查询前必须对 callId 去重");
        assertEquals(distinctCalls + 2, result.toolCallCount(), "重复 callId 仍各自命中同一 tool_call 行");
        assertEquals(distinctCalls + 2, result.records().size(), "转换与装载必须串联（每条消息都产出 VO）");
        for (SessionMessageVO vo : result.records()) {
            assertNotNull(vo.getToolCall());
        }
    }

    @Test
    void missingToolCallRowDegradesHonestlyWithoutDroppingMessages() {
        List<SessionMessage> page = List.of(
                toolMessage(3001L, "call_present"),
                toolMessage(3002L, "call_absent"));
        repository.save(toolCall("call_present", 7L, 70L));

        SessionMessageQueryService.SessionMessageQueryResult result =
                assertDoesNotThrow(() -> queryService.query(page));

        assertEquals(2, result.records().size(), "消息不因 tool_call 缺行而丢失");
        assertEquals(1, result.toolCallCount());
        assertEquals("call_present", result.records().get(0).getToolCallId());
        assertNotNull(result.records().get(0).getToolCall());
        assertEquals("call_absent", result.records().get(1).getToolCallId());
        assertNull(result.records().get(1).getToolCall(), "缺行时 toolCall 为 null，前端据此标不可用");
    }

    @Test
    void querySkipsBatchQueryWhenNoToolRowPresent() {
        List<SessionMessage> page = List.of(
                plainMessage(1L, SessionMessageType.USER, "你好"),
                plainMessage(2L, SessionMessageType.SYSTEM, "系统"));

        SessionMessageQueryService.SessionMessageQueryResult result = queryService.query(page);

        assertEquals(0, result.toolCallCount());
        assertEquals(2, result.records().size());
        assertEquals(0, repository.listByIdsInvocations, "无 TOOL 行时不得发起 tool_call 查询");
    }

    @Test
    void queryHandlesNullSlice() {
        SessionMessageQueryService.SessionMessageQueryResult result =
                assertDoesNotThrow(() -> queryService.query(null));
        assertEquals(0, result.toolCallCount());
        assertEquals(0, result.records().size());
    }

    private static SessionMessage plainMessage(long id, SessionMessageType type, String text) {
        return SessionMessage.builder()
                .id(id)
                .sessionId(7L)
                .type(type)
                .text(text)
                .createTime(Instant.now())
                .build();
    }

    private static SessionMessage toolMessage(long id, String callId) {
        return plainMessage(id, SessionMessageType.TOOL, callId);
    }

    private static ToolCall toolCall(String id, long conversationId, long executionId) {
        return ToolCall.builder()
                .id(id)
                .conversationId(conversationId)
                .executionId(executionId)
                .toolName("read_file")
                .type(ToolCallType.EXECUTE)
                .status(ToolCallStatus.COMPLETED)
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"ok\"}")
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
    }

    /** 计数假仓储：记录 {@code listByIds} 调用次数与实际请求的 id 集合。 */
    private static final class CountingToolCallRepository implements ToolCallRepository {

        private final Map<String, ToolCall> rows = new LinkedHashMap<>();
        private int listByIdsInvocations;
        private Set<String> lastRequestedIds = Set.of();

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
            listByIdsInvocations++;
            lastRequestedIds = new HashSet<>(ids);
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
        public void bindSessionMessage(String toolCallId, Long sessionMessageId) {
            ToolCall row = rows.get(toolCallId);
            if (row != null && sessionMessageId != null) {
                rows.put(toolCallId, row.toBuilder().sessionMessageId(sessionMessageId).build());
            }
        }
    }
}
