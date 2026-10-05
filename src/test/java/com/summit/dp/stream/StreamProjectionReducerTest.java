package com.summit.dp.stream;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.dp.stream.application.projection.RootProjection;
import com.summit.dp.stream.application.projection.StreamProjectionReducer;
import com.summit.dp.stream.application.protocol.StreamOperation;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class StreamProjectionReducerTest {
    private final ObjectMapper json = new ObjectMapper();
    private final StreamProjectionReducer reducer = new StreamProjectionReducer();
    @Test void versionsAreComparedAsLongAndSameVersionDifferentPersistentDataFails() {
        RootProjection root = new RootProjection(1);
        ObjectNode tool = json.createObjectNode().put("id", "a").put("version", "9007199254740993").put("title", "相同内容");
        StreamOperation first = tool(tool);
        assertTrue(reducer.apply(root, first)); assertFalse(reducer.apply(root, first));
        assertFalse(reducer.apply(root, tool(tool.deepCopy().put("version", "9007199254740992"))));
        assertThrows(IllegalStateException.class, () -> reducer.apply(root, tool(tool.deepCopy().put("title", "另一内容"))));
        assertTrue(reducer.apply(root, tool(tool.deepCopy().put("allowedActions", "APPROVE"))));
        assertTrue(reducer.apply(root, tool(tool.deepCopy().put("id", "b"))));
        assertEquals(2, root.tools.size());
    }
    private StreamOperation tool(ObjectNode view) {
        return StreamOperation.create("1", "7", "11", "1", "TOOL_CALL_UPDATED", json.createObjectNode().set("toolCall", view));
    }
}
