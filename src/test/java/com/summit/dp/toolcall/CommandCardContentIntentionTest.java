package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.tools.baseTools.arguments.ExecuteCommandRequest;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * COMMAND 审批卡载荷必须携带模型声明的 {@code intention}（从 args 提取），
 * 前端审批卡据此直接展示意图，不再二次解析 args。
 */
class CommandCardContentIntentionTest {

    private final ToolCallConverter converter = new ToolCallConverter(new ObjectMapper());

    @Test
    void commandContentCarriesIntentionFromArgs() {
        String args = "{\"command\":\"ll\",\"intention\":\"列出当前目录文件\"}";
        JsonNode content = converter.parse(converter.commandContent("ll", "/w", "BASH", "1", args));

        assertEquals("列出当前目录文件", content.get(ExecuteCommandRequest.INTENTION).asText());
        assertEquals("ll", content.get("command").asText());
        assertEquals(args, content.get("args").asText());
    }

    @Test
    void missingOrBlankIntentionOmitsTheKey() {
        JsonNode without = converter.parse(
                converter.commandContent("ll", "/w", "BASH", "1", "{\"command\":\"ll\"}"));
        assertFalse(without.has(ExecuteCommandRequest.INTENTION));

        JsonNode invalidArgs = converter.parse(
                converter.commandContent("ll", "/w", "BASH", "1", "not-json"));
        assertFalse(invalidArgs.has(ExecuteCommandRequest.INTENTION));

        JsonNode nullArgs = converter.parse(converter.commandContent("ll", "/w", "BASH", "1", null));
        assertFalse(nullArgs.has(ExecuteCommandRequest.INTENTION));
        assertTrue(nullArgs.get("args").isNull());
    }
}
