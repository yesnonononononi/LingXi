package com.summit.dp.workflow.infrastructure.harness;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.summit.core.conf.McpConfig;
import com.summit.core.conf.ModelConfig;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.RuntimeConfigurationService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * @deprecated 仅兼容含明文配置的旧快照，完成存量迁移后删除。
 */
@Deprecated(forRemoval = true)
@Component
@RequiredArgsConstructor
public class LegacyExecutionSnapshotAdapter {
    private final ObjectMapper mapper;
    private final RuntimeConfigurationService configurations;

    public void upgrade(ObjectNode root) throws JsonProcessingException {
        if (!(root.path("agentRequest") instanceof ObjectNode request)) return;
        JsonNode legacyModel = request.remove("modelConfig");
        if (legacyModel != null && !legacyModel.isNull() && !request.hasNonNull("modelConfigSpec")) {
            long modelId = request.path("runtimeParameters").path("attributes")
                    .path(ExecutionAttributes.MODEL_CONFIG_ID).asLong(0);
            if (modelId <= 0) modelId = root.path("id").asLong(0);
            request.set("modelConfigSpec", mapper.valueToTree(configurations.freezeModel(modelId,
                    mapper.treeToValue(legacyModel, ModelConfig.class))));
        }
        JsonNode legacyMcp = request.remove("mcpConfig");
        if (legacyMcp != null && !legacyMcp.isNull() && !request.hasNonNull("mcpConfigSpec")) {
            request.set("mcpConfigSpec", mapper.valueToTree(configurations.freezeMcp(mapper.treeToValue(legacyMcp, McpConfig.class))));
        }
        root.remove("mcpConfig");
    }
}
