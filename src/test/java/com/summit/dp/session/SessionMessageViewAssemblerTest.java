package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.session.application.convert.SessionMessageViewAssembler;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 纯转换单测：{@link SessionMessageViewAssembler} 只做内存解析、不触达持久化（评审 P1-③）。
 *
 * <p>「一次批量装载工具调用」的不变式由 {@link SessionMessageQueryServiceTest} 覆盖。</p>
 */
class SessionMessageViewAssemblerTest {

    private SessionMessageViewAssembler assembler;

    @BeforeEach
    void setup() {
        ObjectMapper mapper = new ObjectMapper();
        assembler = new SessionMessageViewAssembler(mapper, new ToolCallConverter(mapper));
    }

    @Test
    void textMessagesAndToolRowAreMappedByType() {
        SessionMessageVO user = assembler.toVO(plainMessage(1L, SessionMessageType.USER, "你好"));
        assertEquals("USER", user.getType());
        assertEquals("你好", user.getText());

        SessionMessageVO system = assembler.toVO(plainMessage(2L, SessionMessageType.SYSTEM, "系统提示"));
        assertEquals("SYSTEM", system.getType());
        assertEquals("系统提示", system.getText());

        SessionMessageVO tool = assembler.toVO(toolMessage(3L, "call_abc"));
        assertEquals("TOOL", tool.getType());
        assertEquals("call_abc", tool.getToolCallId(), "TOOL 行 content 即 call_id");
        assertNull(tool.getToolCall(), "纯转换不装载 toolCall（由查询服务批量回填）");
    }

    @Test
    void malformedAiPayloadFallsBackToRawTextInsteadOfThrowing() {
        SessionMessage broken = plainMessage(9L, SessionMessageType.AI, "not-a-json-payload");
        SessionMessageVO vo = assertDoesNotThrow(() -> assembler.toVO(broken));
        assertEquals("AI", vo.getType());
        assertEquals("not-a-json-payload", vo.getText(), "解析失败按原样降级，消息不丢");
    }

    @Test
    void turnIdIsCarriedStraightFromTheStoredRow() {
        // 归属是消息行自己的列：装配器原样透出，不做任何位置或时间戳推断。
        SessionMessage stored = SessionMessage.builder()
                .id(5L)
                .sessionId(7L)
                .turnId(9001L)
                .type(SessionMessageType.USER)
                .text("你好")
                .createTime(Instant.now())
                .build();

        SessionMessageVO vo = assembler.toVO(stored);

        assertEquals(9001L, vo.getTurnId());
    }

    @Test
    void legacyRowWithoutTurnIdKeepsNullOwnership() {
        // 旧数据归属未知必须原样保持 null：不能伪造一个归属，也不能报错。
        SessionMessageVO vo = assembler.toVO(plainMessage(6L, SessionMessageType.USER, "你好"));
        assertNull(vo.getTurnId());
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
}
