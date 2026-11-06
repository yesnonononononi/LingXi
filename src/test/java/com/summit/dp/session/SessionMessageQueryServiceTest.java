package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.session.application.convert.SessionMessageViewAssembler;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;

/**
 * 读路径「转换 + 按给定字典挂载」查询服务单测（PRD C1 / P0-4 / P2-1，评审 P1-③）。
 *
 * <p>本类只验证<b>挂载与降级</b>：工具调用由调用方一次性装载好传进来（见
 * {@code TurnViewService#loadToolCalls}），本服务不再查库。查询次数的不变式由
 * {@code SessionMessagesBlockViewsTest}（真实 H2 SQL）与 {@code TurnViewServiceBatchAssemblyTest} 钉住。</p>
 */
class SessionMessageQueryServiceTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private SessionMessageQueryService queryService;

    @BeforeEach
    void setup() {
        queryService = new SessionMessageQueryService(
                new SessionMessageViewAssembler(mapper, new ToolCallConverter(mapper)),
                new ToolCallConverter(mapper),
                // 本测试只走 query 路径，findByMessageId 用不到，给一个占位实现即可。
                mock(SessionMessageRepositoryImpl.class));
    }

    @Test
    @DisplayName("重复 callId 各自命中同一行：toolCallCount 按 TOOL 行计，不按去重后的 id 计")
    void duplicateCallIdsEachMountTheSameRow() {
        List<SessionMessage> page = new ArrayList<>();
        Map<String, ToolCall> toolCalls = new LinkedHashMap<>();
        for (int i = 0; i < 20; i++) {
            String callId = "call_" + i;
            page.add(toolMessage(1000L + i, callId));
            toolCalls.put(callId, toolCall(callId, 7L));
        }
        page.add(toolMessage(2000L, "call_0"));
        page.add(toolMessage(2001L, "call_1"));

        SessionMessageQueryService.SessionMessageQueryResult result = queryService.query(page, toolCalls);

        assertEquals(22, result.toolCallCount(), "重复 callId 仍各自命中同一 tool_call 行");
        assertEquals(22, result.records().size(), "每条消息都产出 VO");
        for (SessionMessageVO vo : result.records()) {
            assertNotNull(vo.getToolCall());
        }
    }

    @Test
    @DisplayName("缺行诚实降级：toolCall 为 null，消息不丢、不抛异常")
    void missingToolCallRowDegradesHonestlyWithoutDroppingMessages() {
        List<SessionMessage> page = List.of(
                toolMessage(3001L, "call_present"),
                toolMessage(3002L, "call_absent"));
        Map<String, ToolCall> toolCalls = Map.of("call_present", toolCall("call_present", 7L));

        SessionMessageQueryService.SessionMessageQueryResult result =
                assertDoesNotThrow(() -> queryService.query(page, toolCalls));

        assertEquals(2, result.records().size(), "消息不因 tool_call 缺行而丢失");
        assertEquals(1, result.toolCallCount());
        assertEquals("call_present", result.records().get(0).getToolCallId());
        assertNotNull(result.records().get(0).getToolCall());
        assertEquals("call_absent", result.records().get(1).getToolCallId());
        assertNull(result.records().get(1).getToolCall(), "缺行时 toolCall 为 null，前端据此标不可用");
    }

    @Test
    @DisplayName("无 TOOL 行或空字典：toolCallCount 为 0，VO 照常产出")
    void noToolRowSkipsAttachEntirely() {
        SessionMessageQueryService.SessionMessageQueryResult noToolRow = queryService.query(
                List.of(plainMessage(1L, SessionMessageType.USER, "你好"),
                        plainMessage(2L, SessionMessageType.SYSTEM, "系统")),
                Map.of("call_x", toolCall("call_x", 7L)));
        assertEquals(0, noToolRow.toolCallCount());
        assertEquals(2, noToolRow.records().size());

        SessionMessageQueryService.SessionMessageQueryResult emptyDictionary = queryService.query(
                List.of(toolMessage(3L, "call_y")), Map.of());
        assertEquals(0, emptyDictionary.toolCallCount(), "空字典时不得假装挂上");
        assertNull(emptyDictionary.records().getFirst().getToolCall());
    }

    @Test
    @DisplayName("null 切片与 null 字典都不抛异常")
    void nullInputsAreTolerated() {
        SessionMessageQueryService.SessionMessageQueryResult nullSlice =
                assertDoesNotThrow(() -> queryService.query(null, null));
        assertEquals(0, nullSlice.toolCallCount());
        assertEquals(0, nullSlice.records().size());

        SessionMessageQueryService.SessionMessageQueryResult nullDictionary =
                assertDoesNotThrow(() -> queryService.query(List.of(toolMessage(4L, "call_z")), null));
        assertEquals(0, nullDictionary.toolCallCount());
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

    private static ToolCall toolCall(String id, long conversationId) {
        return ToolCall.builder()
                .id(id)
                .conversationId(conversationId)
                .executionId(conversationId * 10)
                .toolName("read_file")
                .type(ToolCallType.EXECUTE)
                .status(ToolCallStatus.COMPLETED)
                .content("{\"kind\":\"PLAN\"}")
                .rawInput("{\"args\":{}}")
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"ok\"}")
                .metaData("{\"_meta\":{\"schemaVersion\":1}}")
                .createdAt(Instant.now())
                .updatedAt(Instant.now())
                .build();
    }
}