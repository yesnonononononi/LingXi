package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.Execution;
import com.summit.core.conf.SensitiveDataSpec;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.ExecutionSnapshotReader;
import com.summit.dp.workflow.infrastructure.harness.LegacyExecutionSnapshotAdapter;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.*;

class ExecutionSnapshotReaderTest {
    @Test
    void modernSnapshotsNeverEnterTheRetiredAdapter() throws Exception {
        ObjectMapper mapper = new JsonConfig().objectMapper();
        LegacyExecutionSnapshotAdapter legacy = mock(LegacyExecutionSnapshotAdapter.class);
        Execution execution = Execution.builder().agentRequest(AgentRequest.builder()
                .modelConfigSpec(SensitiveDataSpec.builder().id(31L).version(2).build()).build()).build();
        Execution restored = new ExecutionSnapshotReader(mapper, legacy).read(mapper.writeValueAsString(execution));
        assertEquals(2, restored.getAgentRequest().getModelConfigSpec().getVersion());
        verifyNoInteractions(legacy);
    }
}
