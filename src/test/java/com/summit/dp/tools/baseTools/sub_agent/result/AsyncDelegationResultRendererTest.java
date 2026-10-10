package com.summit.dp.tools.baseTools.sub_agent.result;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 受理回执不能承诺邮件交付或暗示任务已验收。 */
class AsyncDelegationResultRendererTest {

    @Test
    void acceptanceDirectsCommanderToArtifactsWithoutRequiringMail() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        ToolExecuteResult result = new AsyncDelegationResultRenderer(mapper).render("9007199254740993", 7L, "工程师");
        assertTrue(result.isSuccess());
        assertFalse(result.isPromise());
        JsonNode payload = mapper.readTree(result.getToolOutput());

        assertEquals("ASYNC", payload.get("runtimeMode").asText());
        assertTrue(payload.get("delegated").asBoolean());
        assertEquals("9007199254740993", payload.get("subSessionId").asText());
        assertEquals(7L, payload.get("agentId").asLong());
        assertEquals("工程师", payload.get("agentName").asText());
        String note = payload.get("note").asText();
        assertTrue(note.contains("子任务尚未完成"));
        assertTrue(note.contains("核验工作目录中的产物和验证记录"));
        assertTrue(note.contains("没有邮件也应自行验收"));
        assertFalse(note.contains("will deliver its result to you by email"));
    }
}
