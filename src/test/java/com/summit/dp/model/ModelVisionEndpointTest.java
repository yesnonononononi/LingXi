package com.summit.dp.model;

import com.summit.dp.model.api.controller.ModelController;
import com.summit.dp.model.application.service.ModelServiceImpl;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.model.domain.repo.ModelConfigRepository;
import com.summit.dp.provider.application.service.ProviderConfigService;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class ModelVisionEndpointTest {
    private final ModelConfigRepository repository = mock(ModelConfigRepository.class);
    private final MockMvc mvc = MockMvcBuilders.standaloneSetup(
            new ModelController(new ModelServiceImpl(repository, mock(ProviderConfigService.class)))).build();

    @Test
    void requestAndResponseCarryTheExplicitBooleanInBothDirections() throws Exception {
        mvc.perform(post("/model/add").contentType(MediaType.APPLICATION_JSON)
                .content("{\"modelName\":\"custom-name\",\"baseUrl\":\"https://example.invalid\",\"apiKey\":\"key\",\"vision\":true}"))
                .andExpect(status().isOk());
        mvc.perform(post("/model/add").contentType(MediaType.APPLICATION_JSON)
                .content("{\"modelName\":\"claude-opus\",\"baseUrl\":\"https://example.invalid\",\"apiKey\":\"key\",\"vision\":false}"))
                .andExpect(status().isOk());
        ArgumentCaptor<ModelConfig> saved = ArgumentCaptor.forClass(ModelConfig.class);
        verify(repository, times(2)).save(saved.capture());
        assertTrue(saved.getAllValues().getFirst().isVision());
        assertFalse(saved.getAllValues().getLast().isVision());
        ModelConfig existing = new ModelConfig(42L, "https://example.invalid", "key", "custom-name", null, true);
        when(repository.findById(42L)).thenReturn(Optional.of(existing));
        mvc.perform(get("/model/find/42")).andExpect(jsonPath("$.data.vision").value(true));
        mvc.perform(post("/model/update").contentType(MediaType.APPLICATION_JSON).content("{\"id\":42,\"vision\":false}"))
                .andExpect(status().isOk());
        mvc.perform(get("/model/find/42")).andExpect(jsonPath("$.data.vision").value(false));
    }
}
