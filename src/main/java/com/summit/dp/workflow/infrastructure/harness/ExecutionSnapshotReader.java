package com.summit.dp.workflow.infrastructure.harness;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.agent.Execution;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** 新快照直接读取，含旧配置字段时才进入兼容路径。 */
@Component
@RequiredArgsConstructor
public class ExecutionSnapshotReader {
    private final ObjectMapper mapper;
    private final LegacyExecutionSnapshotAdapter legacySnapshots;

    public Execution read(String snapshot) throws JsonProcessingException {
        JsonNode tree = mapper.readTree(snapshot);
        if (tree instanceof ObjectNode root && (root.has("mcpConfig")
                || root.path("agentRequest").has("modelConfig") || root.path("agentRequest").has("mcpConfig"))) {
            legacySnapshots.upgrade(root);
        }
        return mapper.treeToValue(tree, Execution.class);
    }
}
