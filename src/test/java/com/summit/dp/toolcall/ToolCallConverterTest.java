package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.model.ToolCatalog;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link ToolCallConverter} 的下发裁剪回归。
 *
 * <p>读文件的结果是文件正文，只有模型需要，前端不展示也不使用，因此下发时丢掉 {@code output}；
 * 但 {@code outcome} 必须保留 —— 前端靠它判成功 / 失败。其余工具（命令、编辑）的结果原样下发。</p>
 */
class ToolCallConverterTest {

    private final ToolCallConverter converter = new ToolCallConverter(new ObjectMapper());

    @Test
    void readFileBodyIsNotSentDownButItsOutcomeIs() {
        ToolCallVO vo = converter.toVO(toolCall(ToolCatalog.READ_FILE,
                "{\"outcome\":\"SUCCEEDED\",\"output\":\"package a;\\nclass A {}\"}"));

        assertFalse(vo.getRawOutput().has("output"), "文件正文不下发");
        assertEquals("SUCCEEDED", vo.getRawOutput().get("outcome").asText(),
                "结论必须保留：前端靠它判成功/失败");
    }

    @Test
    void everyOtherToolKeepsItsOutput() {
        ToolCallVO vo = converter.toVO(toolCall(ToolCatalog.EXECUTE_COMMAND,
                "{\"outcome\":\"SUCCEEDED\",\"output\":\"build ok\"}"));

        assertEquals("build ok", vo.getRawOutput().get("output").asText(),
                "裁剪只针对读文件，不得波及其它工具");
    }

    @Test
    void readFileWithoutOutputOrWithBrokenJsonDoesNotBlowUp() {
        assertNull(converter.toVO(toolCall(ToolCatalog.READ_FILE, null)).getRawOutput());

        ToolCallVO vo = converter.toVO(toolCall(ToolCatalog.READ_FILE, "{\"outcome\":\"CANCELLED\"}"));
        assertEquals("CANCELLED", vo.getRawOutput().get("outcome").asText());
        assertTrue(vo.getRawOutput().isObject());
    }

    private static ToolCall toolCall(String toolName, String rawOutput) {
        return ToolCall.builder()
                .id("call-test")
                .conversationId(1L)
                .executionId(2L)
                .toolName(toolName)
                .rawOutput(rawOutput)
                .build();
    }
}
