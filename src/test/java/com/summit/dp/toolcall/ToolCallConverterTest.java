package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.tools.application.port.ToolCatalog;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

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

    /**
     * 编辑区间必须真的写进 {@code _meta.fileEdit}：行号只在执行那一刻有，不落库就永久丢失。
     * 行号写整数（前端参与计算），记录标识写字符串（前端拼 URL）。
     */
    @Test
    void executionMetaPersistsFileEditRange() throws Exception {
        String meta = converter.executionMeta(7L, ToolCatalog.EDIT_FILE, Map.of(
                "oldStartLine", 3, "oldEndLine", 4, "newStartLine", 3, "newEndLine", 6, "recordId", "r-1"));

        JsonNode fileEdit = new ObjectMapper().readTree(meta).path("_meta").path("fileEdit");
        assertEquals(3, fileEdit.path("oldStartLine").asInt());
        assertEquals(4, fileEdit.path("oldEndLine").asInt());
        assertEquals(3, fileEdit.path("newStartLine").asInt());
        assertEquals(6, fileEdit.path("newEndLine").asInt());
        assertTrue(fileEdit.path("recordId").isTextual(), "记录标识必须是字符串");
        assertEquals("r-1", fileEdit.path("recordId").asText());
    }

    /** 非编辑工具（或没有区间）不得凭空写出 fileEdit 字段，否则历史消息会以为有区间。 */
    @Test
    void executionMetaOmitsFileEditWhenAbsent() throws Exception {
        for (String meta : java.util.List.of(
                converter.executionMeta(7L, ToolCatalog.READ_FILE),
                converter.executionMeta(7L, ToolCatalog.READ_FILE, Map.of()))) {
            assertFalse(new ObjectMapper().readTree(meta).path("_meta").has("fileEdit"), meta);
        }
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
