package com.summit.dp.provider;

import com.summit.dp.model.api.controller.BatchModelController;
import com.summit.dp.model.application.command.BatchModelCommand;
import com.summit.dp.model.application.service.BatchModelService;
import com.summit.dp.model.application.vo.BatchModelResult;
import com.summit.dp.provider.api.controller.ProviderModelsController;
import com.summit.dp.provider.application.service.ProviderModelDiscoveryService;
import com.summit.dp.provider.application.vo.RemoteModelVO;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import java.util.List;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class ProviderModelsEndpointTest {
    @Test
    void discoveryAndBatchPayloadsPreserveAuthoritativeLongIds() throws Exception {
        long id = 9007199254740993L;
        ProviderModelDiscoveryService discovery = mock(ProviderModelDiscoveryService.class);
        BatchModelService batch = mock(BatchModelService.class);
        when(discovery.discover(id, null, null)).thenReturn(List.of(new RemoteModelVO("custom-model")));
        when(batch.add(new BatchModelCommand(id, List.of("custom-model"), false)))
                .thenReturn(new BatchModelResult(1, List.of()));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new ProviderModelsController(discovery), new BatchModelController(batch)).build();
        mvc.perform(post("/provider/models/discover").contentType(MediaType.APPLICATION_JSON)
                .content("{\"providerConfigId\":\"9007199254740993\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data[0].id").value("custom-model"));
        mvc.perform(post("/model/batch/add").contentType(MediaType.APPLICATION_JSON)
                .content("{\"providerConfigId\":\"9007199254740993\",\"modelNames\":[\"custom-model\"],\"vision\":false}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.addedCount").value(1));
        verify(batch).add(new BatchModelCommand(id, List.of("custom-model"), false));
    }
}
