package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.Placement;
import com.summit.dp.shared.vo.block.TextBlock;
import com.summit.dp.shared.vo.block.ThinkingBlock;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.shared.vo.block.TurnViewVO;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Block 契约的序列化边界（用**业务真实的** {@code @Primary ObjectMapper}）。
 *
 * <p><b>为什么必须用真 mapper</b>：{@code JsonConfig#objectMapper} 基于
 * {@code ExecutionJson.newObjectMapper} 并注册了 Long→ToStringSerializer。
 * 轻量 {@code new ObjectMapper()} 会漏掉这些定制 —— 测试绿而线上错，正是要避免的假绿。</p>
 *
 * <p><b>多态声明与字段可见性要分开验证</b>：前者是「type 判别键是否只出现一次、子类型能否还原」，
 * 后者是「字段是否真的被序列化出来」。两者由不同机制决定，一条测试覆盖不了另一条。</p>
 */
class BlockSerializationTest {

    private final ObjectMapper json = new JsonConfig().objectMapper();

    private TurnViewVO sampleView() {
        ThinkingBlock thinking = new ThinkingBlock(
                ThinkingBlock.identity("9007199254740993"), "9007199254740993", 0, BlockStatus.COMPLETE, "思考内容");
        TextBlock body = new TextBlock(
                TextBlock.identity("9007199254740993"), "9007199254740993", 1, BlockStatus.COMPLETE, Placement.BODY, "正文");
        ToolBlock tool = new ToolBlock(
                ToolBlock.identity("call_1"), null, 2, BlockStatus.TOOL_COMPLETED,
                "call_1", "read_file", "{\"path\":\"a\"}", "文件内容", 3, 0);
        return new TurnViewVO(700L, 800L, BlockStatus.TURN_COMPLETED, 5L, "用户提问",
                List.of(thinking, body, tool), null);
    }

    /** 多态声明①：type 判别键只出现一次，不得既有显式字段又有包裹式类型信息。 */
    @Test
    @DisplayName("序列化：type 判别键只出现一次")
    void typeAppearsExactlyOnce() throws Exception {
        String text = json.writeValueAsString(sampleView());
        // 三个块各一个 type，共 3 次；若多态声明与显式字段打架会出现 6 次或出现 @type。
        assertEquals(3, countOccurrences(text, "\"type\""), "type 应每个块恰好一次: " + text);
        assertFalse(text.contains("@type"), "不得出现包裹式类型信息 @type: " + text);
    }

    /** 多态声明②：三个子类型都能按名字还原。 */
    @Test
    @DisplayName("反序列化：三个子类型按名字还原")
    void allSubtypesRoundTrip() throws Exception {
        String text = json.writeValueAsString(sampleView());
        TurnViewVO restored = json.readValue(text, TurnViewVO.class);

        assertEquals(3, restored.blocks().size());
        assertInstanceOf(ThinkingBlock.class, restored.blocks().get(0));
        assertInstanceOf(TextBlock.class, restored.blocks().get(1));
        assertInstanceOf(ToolBlock.class, restored.blocks().get(2));
        assertEquals("思考内容", ((ThinkingBlock) restored.blocks().get(0)).text());
        assertEquals(Placement.BODY, ((TextBlock) restored.blocks().get(1)).placement());
    }

    /** 字段可见性：所有契约字段真的出现在 JSON 里（不是只在对象上）。 */
    @Test
    @DisplayName("序列化：契约字段全部落到 JSON")
    void contractFieldsAreVisible() throws Exception {
        String text = json.writeValueAsString(sampleView());
        for (String field : List.of("sessionId", "turnId", "status", "viewVersion",
                "blockId", "responseId", "order", "placement", "toolCallId", "toolName")) {
            assertTrue(text.contains("\"" + field + "\""), "字段缺失: " + field + " in " + text);
        }
        // Long 走 ToStringSerializer：turnId 必须是字符串，避免前端大整数精度丢失。
        assertTrue(text.contains("\"turnId\":\"800\""), "turnId 应为字符串: " + text);
    }

    /** 失败边界：未知子类型必须明确失败，不得静默转成某个默认类型。 */
    @Test
    @DisplayName("反序列化：未知子类型明确失败")
    void unknownSubtypeFailsLoudly() {
        String bad = "{\"sessionId\":1,\"turnId\":2,\"status\":\"RUNNING\",\"viewVersion\":1,"
                + "\"blocks\":[{\"type\":\"MYSTERY\",\"blockId\":\"x\"}]}";
        assertThrows(Exception.class, () -> json.readValue(bad, TurnViewVO.class));
    }

    private static int countOccurrences(String haystack, String needle) {
        int count = 0;
        int index = haystack.indexOf(needle);
        while (index >= 0) {
            count++;
            index = haystack.indexOf(needle, index + needle.length());
        }
        return count;
    }
}
